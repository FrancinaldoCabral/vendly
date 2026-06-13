/**
 * webhook.ts — Chatwoot webhook receiver (replaces wf-entrada-v1 N8N workflow)
 * Registers Express route: POST /webhook/chatwoot/:agentId
 * Handles dedup, buffer push, debounce scheduling.
 */
import type { Router, Request, Response } from 'express';
import { getRedis } from '../tools/redis.js';
import { getDb } from '../tools/mongodb.js';
import { scheduleDebounce } from './debounce.js';

const DEDUP_TTL = 120; // seconds — matches original wf-entrada-v1

// ── Chatwoot webhook payload shapes ─────────────────────────────────────────

interface ChatwootMessage {
  id?: number;
  content?: string;
  message_type?: string; // 'incoming' | 'outgoing' | 'activity'
  created_at?: number;
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

  // Identifier from Evolution is typically the JID (e.g., 5511999@s.whatsapp.net)
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

// ── Route registration ───────────────────────────────────────────────────────

export function registerWebhookRoute(router: Router): void {
  router.post('/webhook/chatwoot/:agentId', async (req: Request, res: Response) => {
    // Ack immediately — Chatwoot retries on timeout
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
  // Only process incoming messages
  if (payload.event !== 'message_created') return;
  if (payload.message?.message_type !== 'incoming') return;

  const conversationId = payload.conversation?.id;
  if (!conversationId) return;

  // Skip if a human agent is assigned (human_takeover)
  if (payload.conversation?.assignee) return;

  const redis = getRedis();

  // Dedup: skip if we've seen this exact message recently
  const msgId = payload.message?.id;
  const msgTs = payload.message?.created_at;
  const dedupKey = `cw_dedup:${conversationId}:${msgId ?? msgTs}`;
  const already = await redis.set(dedupKey, '1', 'EX', DEDUP_TTL, 'NX');
  if (!already) {
    console.log(`[webhook] DEDUP skip agentId=${agentId} convId=${conversationId} msgId=${msgId}`);
    return;
  }

  // Look up tenantId from agent document
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

  // Build buffer entry
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

  // Push to buffer (LPUSH → RPOP = FIFO when reversed in processBuffer)
  const bufferKey = `buffer:t:${tenantId}:${conversationId}`;
  await redis.lpush(bufferKey, entry);
  await redis.expire(bufferKey, 60 * 5); // 5 min safety TTL

  console.log(`[webhook] buffered agentId=${agentId} tenantId=${tenantId} convId=${conversationId} senderPhone=${senderPhone} text="${text.slice(0, 60)}"`);

  // Schedule debounce timer
  scheduleDebounce(agentId, String(conversationId), tenantId);
}
