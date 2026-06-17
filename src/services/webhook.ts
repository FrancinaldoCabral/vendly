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
import { groupFilter, type GroupConfig } from './group-filter.js';
import { getAgentPhone } from './agent-loop.js';
import {
  classifyEvolutionMedia,
  fetchEvolutionMediaBase64,
  transcribeAudio,
} from './media.js';

const DEDUP_TTL = 120; // seconds
const EV_PROC_TTL = 30; // seconds — how long Evolution "claimed" a message

// ── Contact filter (blacklist / whitelist) + multi-agent routing ─────────────
// One WhatsApp connection (Evolution instance) can be shared by many agents.
// Each agent has its own contactFilter. For an incoming chat we pick the FIRST
// agent (by priority) whose filter lets the chat through. Default filter = empty
// blacklist → that agent responds to everything (the catch-all). This is how a
// client models their business (e.g. livraeats: restaurant agent + driver agent).

interface ContactFilter {
  mode: 'blacklist' | 'whitelist';
  contacts: string[];
  groups: string[];
}

interface RoutableAgent {
  _id: string;
  tenantId: string;
  priority?: number;
  contactFilter?: Partial<ContactFilter>;
  groupConfig?: GroupConfig;
}

/** Pull the reply/quote context out of any message type (for accurate group reply detection). */
function extractReplyContext(message: Record<string, unknown>): { stanzaId?: string; participant?: string } {
  const types = ['extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
  for (const t of types) {
    const ci = (message[t] as Record<string, unknown> | undefined)?.contextInfo as Record<string, unknown> | undefined;
    if (ci?.stanzaId) return { stanzaId: String(ci.stanzaId), participant: ci.participant ? String(ci.participant) : undefined };
  }
  const ci2 = (message as Record<string, unknown>).contextInfo as Record<string, unknown> | undefined;
  if (ci2?.stanzaId) return { stanzaId: String(ci2.stanzaId), participant: ci2.participant ? String(ci2.participant) : undefined };
  return {};
}

/** Plain text from a message WITHOUT downloading/transcribing media (cheap, for the early gate). */
function cheapText(message: Record<string, unknown>): string {
  const ext = (message.extendedTextMessage as Record<string, unknown> | undefined)?.text;
  const imgCap = (message.imageMessage as Record<string, unknown> | undefined)?.caption;
  const vidCap = (message.videoMessage as Record<string, unknown> | undefined)?.caption;
  const docCap = (message.documentMessage as Record<string, unknown> | undefined)?.caption;
  return String(message.conversation ?? ext ?? imgCap ?? vidCap ?? docCap ?? '');
}

/** Does this agent's filter let a message from `senderPhone` in chat `jid` through? */
function agentClaims(agent: RoutableAgent, jid: string, senderPhone: string): boolean {
  const f = agent.contactFilter ?? {};
  const mode = f.mode === 'whitelist' ? 'whitelist' : 'blacklist';
  const isGroup = jid.endsWith('@g.us');
  const phone = senderPhone.replace(/\D/g, '');
  const listed = isGroup ? (f.groups ?? []).includes(jid) : (f.contacts ?? []).includes(phone);
  return mode === 'whitelist' ? listed : !listed;
}

/** Pick the owning agent for a chat among all agents on a connection (priority order). */
function routeAgent<T extends RoutableAgent>(agents: T[], jid: string, senderPhone: string): T | null {
  return agents.find(a => agentClaims(a, jid, senderPhone)) ?? null;
}

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

interface ChatwootConversation {
  id?: number;
  status?: string;            // 'open' | 'pending' | 'resolved' | 'snoozed'
  assignee?: unknown;         // set when a human agent is assigned
  assignee_id?: number | null;
  inbox_id?: number;
  meta?: {
    assignee?: { id?: number } | null;
    sender?: { name?: string; phone_number?: string; identifier?: string };
  };
}

interface ChatwootPayload {
  event?: string;
  message_type?: string;
  message?: ChatwootMessage;
  conversation?: ChatwootConversation;
  contact?: {
    phone_number?: string;
    name?: string;
    identifier?: string;
  };
  // conversation_* events deliver the conversation fields at the TOP level too.
  id?: number;
  status?: string;
  assignee?: unknown;
  assignee_id?: number | null;
  inbox_id?: number;
  meta?: {
    assignee?: { id?: number } | null;
    sender?: { name?: string; phone_number?: string; identifier?: string };
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
  // :subjectId is a connectionId (current) or a legacy agentId (older provisions).
  router.post('/webhook/chatwoot/:subjectId', async (req: Request, res: Response) => {
    res.status(200).json({ ok: true });

    const { subjectId } = req.params;
    const body = req.body as ChatwootPayload;

    try {
      const event = body.event ?? '';
      if (event.startsWith('conversation_')) {
        await handleChatwootHandoff(subjectId, body);
      } else {
        await handleChatwootWebhook(subjectId, body);
      }
    } catch (e) {
      console.error(`[webhook] Error subjectId=${subjectId}:`, String(e));
    }
  });
}

/**
 * Bot <-> human handoff, driven by Chatwoot conversation assignment (like the old system):
 *  - a human agent is assigned (and not resolved) -> pause the bot for that contact
 *  - unassigned ("none") OR resolved -> the bot resumes
 * The bot itself can escalate by assigning the conversation to a human (escalateToHuman),
 * which lands here as an assignment and pauses the bot.
 */
async function handleChatwootHandoff(subjectId: string, payload: ChatwootPayload): Promise<void> {
  // conversation_* events carry the conversation either nested or at top level.
  const conv: ChatwootConversation = payload.conversation ?? {
    id: payload.id, status: payload.status, assignee: payload.assignee,
    assignee_id: payload.assignee_id, inbox_id: payload.inbox_id, meta: payload.meta,
  };
  const convId = conv.id;
  if (!convId) return;

  const { senderPhone, contactJid } = extractSender(
    payload.conversation ? payload : ({ ...payload, conversation: conv } as ChatwootPayload),
  );
  if (!contactJid && !senderPhone) { console.warn(`[handoff] no contact in conversation_updated subjectId=${subjectId}`); return; }

  const candidates = await resolveChatwootAgents(subjectId);
  if (candidates.length === 0) return;
  const owner = routeAgent(candidates, contactJid, senderPhone) ?? candidates[0];
  const tenantId = owner.tenantId;

  // Is a human currently assigned?
  const assigneeId = conv.assignee_id ?? conv.meta?.assignee?.id ?? payload.assignee_id ?? payload.meta?.assignee?.id ?? null;
  const assigned = !!conv.assignee || !!conv.meta?.assignee || !!payload.assignee || !!payload.meta?.assignee || !!assigneeId;
  const resolved = (conv.status ?? payload.status) === 'resolved';
  const humanActive = assigned && !resolved;

  // Must match the key the debounce worker checks: human_takeover:t:{tenant}:{agent}:{jidKey}
  // where jidKey is the sanitized contact JID. Fall back to a phone-derived JID if needed.
  const jid = contactJid || (senderPhone ? `${senderPhone}@s.whatsapp.net` : '');
  if (!jid) return;
  const jidKey = jid.replace(/[^a-z0-9]/gi, '_');
  const key = `human_takeover:t:${tenantId}:${owner._id}:${jidKey}`;
  const redis = getRedis();

  if (humanActive) {
    await redis.set(key, '1', 'EX', 60 * 60 * 24 * 7); // 7 days
    console.log(`[handoff] PAUSE bot agent=${owner._id} conv=${convId} jid=${jid} (assigneeId=${assigneeId} status=${conv.status ?? payload.status})`);
  } else {
    await redis.del(key);
    console.log(`[handoff] RESUME bot agent=${owner._id} conv=${convId} jid=${jid} (assigned=${assigned} resolved=${resolved})`);
  }
}

/** Resolve the candidate agents for a Chatwoot webhook subject (connection or legacy agent). */
async function resolveChatwootAgents(subjectId: string): Promise<Array<RoutableAgent & { chatwootInboxId?: number; status?: string }>> {
  const db = await getDb();
  // Preferred: subject is a connection → all its agents
  const conn = await db.collection('connections').findOne(
    { _id: subjectId } as Record<string, unknown>,
    { projection: { _id: 1 } },
  );
  if (conn) {
    const agents = (await db.collection('agents').find(
      { connectionId: subjectId } as Record<string, unknown>,
      { projection: { _id: 1, tenantId: 1, priority: 1, contactFilter: 1, chatwootInboxId: 1, status: 1 } },
    ).toArray()) as unknown as Array<RoutableAgent & { chatwootInboxId?: number; status?: string }>;
    return agents
      .filter(a => a.status !== 'paused')
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || String(a._id).localeCompare(String(b._id)));
  }
  // Legacy: subject is an agent id
  const agent = (await db.collection('agents').findOne(
    { _id: subjectId } as Record<string, unknown>,
    { projection: { _id: 1, tenantId: 1, priority: 1, contactFilter: 1, chatwootInboxId: 1, status: 1 } },
  )) as unknown as (RoutableAgent & { chatwootInboxId?: number; status?: string }) | null;
  return agent ? [agent] : [];
}

async function handleChatwootWebhook(subjectId: string, payload: ChatwootPayload): Promise<void> {
  if (payload.event !== 'message_created') return;
  if (payload.message?.message_type !== 'incoming') return;

  const conversationId = payload.conversation?.id;
  if (!conversationId) return;

  if (payload.conversation?.assignee) return;

  const candidates = await resolveChatwootAgents(subjectId);
  if (candidates.length === 0) {
    console.warn(`[webhook] no agents for subjectId=${subjectId}`);
    return;
  }

  // Route by sender → first agent whose filter claims this chat
  const { senderPhone, senderName, contactJid } = extractSender(payload);
  const owner = routeAgent(candidates, contactJid, senderPhone);
  if (!owner) {
    console.log(`[webhook] no agent claims chat subjectId=${subjectId} jid=${contactJid} sender=${senderPhone}`);
    return;
  }
  const agentId = String(owner._id);
  const tenantId = owner.tenantId;

  // Inbox guard: drop if the conversation's inbox doesn't belong to the owner's connection
  const inboxId = payload.conversation?.inbox_id;
  if (inboxId && owner.chatwootInboxId && owner.chatwootInboxId !== inboxId) {
    console.log(`[webhook] inbox_id mismatch subjectId=${subjectId} expected=${owner.chatwootInboxId} got=${inboxId} — skipping`);
    return;
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

  // Load ALL agents listening on this connection, in priority order (then age).
  const agents = (await db.collection('agents').find(
    { evolutionInstance: instance } as Record<string, unknown>,
    { projection: { _id: 1, tenantId: 1, priority: 1, contactFilter: 1, groupConfig: 1, status: 1 } },
  ).toArray()) as unknown as Array<RoutableAgent & { status?: string }>;
  // Only active/pending agents participate; sort by priority asc, stable by id.
  const ordered = agents
    .filter(a => a.status !== 'paused')
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || String(a._id).localeCompare(String(b._id)));

  if (ordered.length === 0) {
    console.warn(`[ev-webhook] no agent found for instance=${instance}`);
    return;
  }
  const tenantId = ordered[0].tenantId;

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

    // For group messages: remoteJid is the group, participant is the actual sender
    const isGroup = jid.endsWith('@g.us');
    const senderJid = isGroup ? String(key.participant ?? jid) : jid;
    const senderPhone = senderJid.replace(/@[^@]+$/, '').replace(/\D/g, '');
    const pushName = String(msg.pushName ?? '');

    // Mark as "processed by Evolution path" so the Chatwoot fallback skips it — even
    // if we filter it out below, so a filtered group message is never reprocessed.
    await redis.set(`ev_proc:${msgId}`, '1', 'EX', EV_PROC_TTL);

    // Route to the owning agent (first whose blacklist/whitelist lets this chat through).
    const owner = routeAgent(ordered, jid, senderPhone);
    if (!owner) {
      console.log(`[ev-webhook] no agent claims chat instance=${instance} jid=${jid} sender=${senderPhone}`);
      continue;
    }
    const agentId = String(owner._id);

    const message = (msg.message ?? {}) as Record<string, unknown>;
    const extMsg = (message.extendedTextMessage ?? {}) as Record<string, unknown>;

    // ── EARLY group gate (before any media download/transcription = no wasted cost) ──
    const reply = extractReplyContext(message);
    let bufWaExternalId: string | null = reply.stanzaId ?? null;
    if (isGroup) {
      const gc: GroupConfig = owner.groupConfig ?? { respondToMentions: true, respondToReplies: true, respondToAll: false };
      const botPhone = await getAgentPhone(instance);
      const replyParticipant = (reply.participant ?? '').replace(/@[^@]+$/, '').replace(/\D/g, '');
      // A reply counts toward "respondToReplies" only if it replies to the BOT's message.
      const replyToBot = !!reply.stanzaId && (
        !botPhone || !replyParticipant ||
        replyParticipant === botPhone || botPhone.endsWith(replyParticipant) || replyParticipant.endsWith(botPhone)
      );
      const gate = groupFilter({
        jid,
        messageText: cheapText(message), // text only — audio NOT transcribed yet
        waExternalId: replyToBot ? reply.stanzaId : null,
        agentPhone: botPhone,
        senderPhone,
        groupConfig: gc,
      });
      if (!gate.pass) {
        console.log(`[ev-webhook] group message ignored (no cost): ${gate.reason}`);
        continue;
      }
      bufWaExternalId = replyToBot ? (reply.stanzaId ?? null) : null;
    }

    // Extract text from various WhatsApp message types
    let text = String(message.conversation ?? extMsg.text ?? '');

    // Multimodal input: classify + download + (audio) transcribe / (visual) attach base64
    let mediaBase64: string | undefined;
    let mediaMimetype: string | undefined;
    let mediaKind: string | undefined;
    let mediaFileName: string | undefined;
    let userSentAudio = false;

    const media = classifyEvolutionMedia(message);
    if (media) {
      if (media.caption && !text) text = media.caption;
      if (media.kind === 'audio') {
        userSentAudio = true;
        const fetched = await fetchEvolutionMediaBase64(instance, msg);
        if (fetched) {
          const transcript = await transcribeAudio(fetched.base64, fetched.mimetype ?? media.mimetype);
          text = [text, transcript].filter(Boolean).join('\n') || '[Áudio sem fala reconhecível]';
        } else {
          text = text || '[Áudio recebido]';
        }
      } else if (media.kind === 'sticker') {
        text = text || '[Figurinha]';
      } else {
        // image / video / document → attach bytes for the multimodal model
        const fetched = await fetchEvolutionMediaBase64(instance, msg);
        if (fetched) {
          mediaBase64 = fetched.base64;
          mediaMimetype = fetched.mimetype ?? media.mimetype;
          mediaKind = media.kind;
          mediaFileName = media.fileName;
          if (!text) {
            text = media.kind === 'document'
              ? `[Documento: ${media.fileName ?? 'arquivo'}]`
              : media.kind === 'image' ? '[Imagem]' : '[Vídeo]';
          }
        }
      }
    }

    // Conversation key: per-contact for direct chats, per-group-member for groups
    const groupSan = jid.replace(/[^a-z0-9]/gi, '_');
    const convKey = isGroup ? `${groupSan}_${senderPhone}` : groupSan;
    const bufferKey = `buffer:t:${tenantId}:ev:${convKey}`;

    const entry = JSON.stringify({
      text,
      mediaBase64,
      mediaMimetype,
      mediaKind,
      mediaFileName,
      userSentAudio,
      senderPhone,
      senderName: pushName || senderPhone || 'Usuário',
      contactJid: jid,
      messageId: msgId, // the WhatsApp id of THIS incoming message (for reactions)
      waExternalId: bufWaExternalId, // real reply-to-bot id (groups) or null — not the msg's own id
      chatwootConvId: null, // no Chatwoot conv ID in direct Evolution path
      timestamp: Date.now(),
    });

    await redis.lpush(bufferKey, entry);
    await redis.expire(bufferKey, 300);

    // Keep a short rolling log of recent messages (id + text) so the agent can react to
    // any message in the conversation by referencing its text — never by raw id.
    const recentKey = `recent:t:${tenantId}:ev:${convKey}`;
    await redis.lpush(recentKey, JSON.stringify({ id: msgId, text: text.slice(0, 200) }));
    await redis.ltrim(recentKey, 0, 19);
    await redis.expire(recentKey, 60 * 60 * 24);

    console.log(`[ev-webhook] buffered agent=${agentId} tenant=${tenantId} jid=${jid} kind=${mediaKind ?? (userSentAudio ? 'audio' : 'text')} text="${text.slice(0, 60)}"`);

    scheduleDebounce(agentId, `ev:${convKey}`, tenantId);
  }
}
