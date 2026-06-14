/**
 * webhook.ts — Chatwoot webhook receiver + Evolution MESSAGES_UPSERT handler
 * Chatwoot webhook: receives agent triggers from Chatwoot (fallback path)
 * Evolution webhook: receives messages directly (primary path, faster + more reliable)
 *
 * Dual-path dedup: Evolution sets `ev_proc:{msgId}`, Chatwoot checks it via external_id.
 * This ensures each message is processed exactly once.
 */
import type { Router, Request, Response } from 'express';
import { getRedis } from '../tools/redis.js';
import { getDb } from '../tools/mongodb.js';
import { scheduleDebounce } from './debounce.js';

const DEDUP_TTL = 120; // seconds
const EV_PROC_TTL = 30; // seconds — how long Evolution "claimed" a message

// ── Chatwoot webhook payload shapes ─────────────────────────────────────────

interface ChatwootMessage {
  id?: number;
  content?: string;
  message_type?: string; // 'incoming' | 'outgoing' | 'activity'
  created_at?: number;
  external_id?: string;  // WhatsApp message ID (set by Evolution Chatwoot integration)
  content_type?: string;
  content_attributes?: {
    in_reply_to?: number;
    in_reply_to_external_id?: string;
  };
  attachments?: Array<{
    file_type?: string;
    data_url?: string;
    thumb_url?: string;
  }>;
  sender?: {
    name?: string;
    phone_number?: string;
    identifier?: string;
  };
}

interface ChatwootPayload {
  event?: string;
  message_type?: string;
  message?: ChatwootMessage;
  conversation?: {
    id?: number;
    assignee?: unknown;
    inbox_id?: number;
    meta?: {
      sender?: {
        name?: string;
        phone_number?: string;
        identifier?: string;
      };
    };
  };
  contact?: {
    phone_number?: string;
    name?: string;
    identifier?: string;
  };
}

// ── Helper: extract phone/JID from Chatwoot payload ─────────────────────────

function extractSender(payload: ChatwootPayload): { senderPhone: string; senderName: string; contactJid: string } {
  const meta = payload.conversation?.meta?.sender;
  const contact = payload.contact;
  const msgSender = payload.message?.sender;

  const rawPhone = (meta?.phone_number ?? contact?.phone_number ?? msgSender?.phone_number ?? '').replace(/\D/g, '');
  const identifier = meta?.identifier ?? contact?.identifier ?? msgSender?.identifier ?? '';
  const senderName = meta?.name ?? contact?.name ?? msgSender?.name ?? 'Usuário';

  const contactJid = identifier.includes('@') ? identifier : rawPhone ? `${rawPhone}@s.whatsapp.net` : '';
  const senderPhone = rawPhone || identifier.replace(/@[^@]+$/, '').replace(/\D/g, '');

  return { senderPhone, senderName, contactJid };
}

function extractMedia(message: ChatwootMessage): { mediaUrl?: string; mediaType?: string } {
  const att = message.attachments?.[0];
  if (!att) return {};
  const url = att.data_url ?? att.thumb_url;
  return url ? { mediaUrl: url, mediaType: att.file_type } : {};
}

// ── Chatwoot webhook route ───────────────────────────────────────────────────

export function registerWebhookRoute(router: Router): void {
  router.post('/webhook/chatwoot/:agentId', async (req: Request, res: Response) => {
    res.status(200).json({ ok: true });

    const { agentId } = req.params;
    const body = req.body as ChatwootPayload;

    try {
      await handleChatwootWebhook(agentId, body);
    } catch (e) {
      console.error(`[webhook] Error agentId=${agentId}:`, String(e));
    }
  });
}

async function handleChatwootWebhook(agentId: string, payload: ChatwootPayload): Promise<void> {
  if (payload.event !== 'message_created') return;
  if (payload.message?.message_type !== 'incoming') return;

  const conversationId = payload.conversation?.id;
  if (!conversationId) return;

  if (payload.conversation?.assignee) return;

  // Check if inbox_id matches this agent
  const inboxId = payload.conversation?.inbox_id;
  if (inboxId) {
    const db = await getDb();
    const agentDoc = await db.collection('agents').findOne(
      { _id: agentId } as Record<string, unknown>,
      { projection: { chatwootInboxId: 1 } },
    ) as { chatwootInboxId?: number } | null;
    if (agentDoc?.chatwootInboxId && agentDoc.chatwootInboxId !== inboxId) {
      console.log(`[webhook] inbox_id mismatch — agentId=${agentId} expected=${agentDoc.chatwootInboxId} got=${inboxId} — skipping`);
      return;
    }
  }

  const redis = getRedis();

  // Skip if already processed by Evolution MESSAGES_UPSERT (primary path)
  const externalId = payload.message?.external_id;
  if (externalId) {
    const evProcKey = `ev_proc:${externalId}`;
    const alreadyProcessed = await redis.get(evProcKey);
    if (alreadyProcessed) {
      console.log(`[webhook] SKIP: already processed via Evolution path msgId=${externalId}`);
      return;
    }
  }

  // Dedup: skip if we've seen this exact Chatwoot message recently
  const msgId = payload.message?.id;
  const msgTs = payload.message?.created_at;
  const dedupKey = `cw_dedup:${conversationId}:${msgId ?? msgTs}`;
  const already = await redis.set(dedupKey, '1', 'EX', DEDUP_TTL, 'NX');
  if (!already) {
    console.log(`[webhook] DEDUP skip agentId=${agentId} convId=${conversationId} msgId=${msgId}`);
    return;
  }

  const db = await getDb();
  const agentDoc = await db.collection<{ _id: string; tenantId?: string }>('agents').findOne(
    { _id: agentId },
    { projection: { tenantId: 1 } },
  );

  const tenantId = agentDoc?.tenantId ?? '';
  if (!tenantId) {
    console.error(`[webhook] tenantId not found for agentId=${agentId}`);
    return;
  }

  const { senderPhone, senderName, contactJid } = extractSender(payload);
  const { mediaUrl, mediaType } = extractMedia(payload.message!);
  const text = payload.message?.content ?? '';
  const waExternalId = payload.message?.content_attributes?.in_reply_to_external_id ?? null;

  const entry = JSON.stringify({
    text,
    mediaUrl,
    mediaType,
    senderPhone,
    senderName,
    contactJid,
    waExternalId,
    chatwootConvId: conversationId,
    timestamp: Date.now(),
  });

  const bufferKey = `buffer:t:${tenantId}:${conversationId}`;
  await redis.lpush(bufferKey, entry);
  await redis.expire(bufferKey, 60 * 5);

  console.log(`[webhook] buffered agentId=${agentId} tenantId=${tenantId} convId=${conversationId} text="${text.slice(0, 60)}"`);

  scheduleDebounce(agentId, String(conversationId), tenantId);
}

// ── Evolution MESSAGES_UPSERT handler (primary message path) ─────────────────

export async function handleEvolutionMessageWebhook(
  instance: string,
  body: Record<string, unknown>,
): Promise<void> {
  const data = (body.data ?? {}) as Record<string, unknown>;

  // Normalize to array — Evolution sends single object OR { messages: [...] } OR top-level array
  let rawMsgs: Array<Record<string, unknown>>;
  if (Array.isArray(data)) {
    rawMsgs = data as Array<Record<string, unknown>>;
  } else if (Array.isArray(data.messages)) {
    rawMsgs = data.messages as Array<Record<string, unknown>>;
  } else {
    rawMsgs = [data];
  }

  if (rawMsgs.length === 0) return;

  const redis = getRedis();
  const db = await getDb();

  // Look up agent once for this instance
  const agentDoc = await db.collection<{ _id: string; tenantId?: string; chatwootInboxId?: number }>('agents').findOne(
    { evolutionInstance: instance } as Record<string, unknown>,
    { projection: { _id: 1, tenantId: 1 } },
  );
  if (!agentDoc?.tenantId) {
    console.warn(`[ev-webhook] no agent found for instance=${instance}`);
    return;
  }
  const agentId = String(agentDoc._id);
  const tenantId = agentDoc.tenantId;

  for (const msg of rawMsgs) {
    const key = (msg.key ?? {}) as Record<string, unknown>;
    if (key.fromMe) continue; // skip our own outgoing messages

    const jid = String(key.remoteJid ?? '');
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast')) continue;

    const msgId = String(key.id ?? '');
    if (!msgId) continue;

    // Primary dedup by WhatsApp message ID
    const waDedupKey = `wa_dedup:${instance}:${msgId}`;
    const claimed = await redis.set(waDedupKey, '1', 'EX', DEDUP_TTL, 'NX');
    if (!claimed) {
      console.log(`[ev-webhook] DEDUP skip instance=${instance} msgId=${msgId}`);
      continue;
    }

    // Mark as "processed by Evolution path" so Chatwoot webhook skips it
    await redis.set(`ev_proc:${msgId}`, '1', 'EX', EV_PROC_TTL);

    // Extract text from various WhatsApp message types
    const message = (msg.message ?? {}) as Record<string, unknown>;
    const extMsg = (message.extendedTextMessage ?? {}) as Record<string, unknown>;
    const imgMsg = (message.imageMessage ?? {}) as Record<string, unknown>;
    const vidMsg = (message.videoMessage ?? {}) as Record<string, unknown>;
    const docMsg = (message.documentMessage ?? {}) as Record<string, unknown>;

    const text = String(
      message.conversation
        ?? extMsg.text
        ?? imgMsg.caption
        ?? vidMsg.caption
        ?? docMsg.caption
        ?? (message.audioMessage ? '[Áudio]' : message.stickerMessage ? '[Sticker]' : '')
    );

    // For group messages: remoteJid is the group, participant is the actual sender
    const isGroup = jid.endsWith('@g.us');
    const senderJid = isGroup ? String(key.participant ?? jid) : jid;
    const senderPhone = senderJid.replace(/@[^@]+$/, '').replace(/\D/g, '');
    const pushName = String(msg.pushName ?? '');

    // Use JID as conversation key (stable across sessions, unique per contact/group)
    const convKey = jid.replace(/[^a-z0-9]/gi, '_');
    const bufferKey = `buffer:t:${tenantId}:ev:${convKey}`;

    const entry = JSON.stringify({
      text,
      senderPhone,
      senderName: pushName || senderPhone || 'Usuário',
      contactJid: jid,
      waExternalId: msgId,
      chatwootConvId: null, // no Chatwoot conv ID in direct Evolution path
      timestamp: Date.now(),
    });

    await redis.lpush(bufferKey, entry);
    await redis.expire(bufferKey, 300);

    console.log(`[ev-webhook] buffered agent=${agentId} tenant=${tenantId} jid=${jid} text="${text.slice(0, 60)}"`);

    scheduleDebounce(agentId, `ev:${convKey}`, tenantId);
  }
}
