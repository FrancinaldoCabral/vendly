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
import { scheduleDebounce, resolveOrCreateConversation, postChatwootMessage, postChatwootNote } from './debounce.js';
import { groupFilter, type GroupConfig } from './group-filter.js';
import { getAgentPhone, getAgentIdentities } from './agent-loop.js';
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

/** Pull the reply/quote context out of a message. WhatsApp uses two shapes:
 *  (a) the classic contextInfo.stanzaId, and (b) the newer "thread" reply:
 *      messageContextInfo.threadId[].threadKey.{id, participant}.
 *  We handle both (deep-searching for the classic one across nested message types). */
function extractReplyContext(message: Record<string, unknown>): { stanzaId?: string; participant?: string } {
  // (b) New thread-reply structure.
  const mci = message.messageContextInfo as Record<string, unknown> | undefined;
  const threads = mci?.threadId as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(threads)) {
    for (const t of threads) {
      const tk = t?.threadKey as Record<string, unknown> | undefined;
      if (tk?.id) return { stanzaId: String(tk.id), participant: tk.participant ? String(tk.participant) : undefined };
    }
  }
  // (a) Classic structure — deep-search for stanzaId wherever it is nested.
  let found: { stanzaId?: string; participant?: string } = {};
  const visit = (o: unknown, depth: number) => {
    if (found.stanzaId || !o || typeof o !== 'object' || depth > 6) return;
    const r = o as Record<string, unknown>;
    const sid = r.stanzaId ?? r.stanzaID ?? r.stanza_id;
    if (typeof sid === 'string' && sid) {
      const part = r.participant ?? r.remoteJid;
      found = { stanzaId: sid, participant: typeof part === 'string' ? part : undefined };
      return;
    }
    for (const v of Object.values(r)) {
      if (found.stanzaId) break;
      if (v && typeof v === 'object') visit(v, depth + 1);
    }
  };
  visit(message, 0);
  return found;
}

/** Phone numbers mentioned in a message (contextInfo.mentionedJid) — the authoritative @mention
 *  source on WhatsApp. Checks every message type that can carry a contextInfo. */
function extractMentionedPhones(message: Record<string, unknown>): string[] {
  const found = new Set<string>();
  const collect = (ci: unknown) => {
    const arr = (ci as Record<string, unknown> | undefined)?.mentionedJid;
    if (Array.isArray(arr)) for (const j of arr) {
      const p = String(j).replace(/@[^@]+$/, '').replace(/\D/g, '');
      if (p) found.add(p);
    }
  };
  const types = ['extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
  for (const t of types) collect((message[t] as Record<string, unknown> | undefined)?.contextInfo);
  collect((message as Record<string, unknown>).contextInfo);
  return [...found];
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

  // The account-level webhook fires for EVERY conversation in the account. If the tenant has
  // more than one connection/inbox, ignore events whose inbox doesn't belong to this subject's
  // agents — otherwise we'd pause/resume an agent on the wrong number.
  const convInboxId = conv.inbox_id ?? payload.inbox_id;
  if (convInboxId && owner.chatwootInboxId && owner.chatwootInboxId !== convInboxId) {
    console.log(`[handoff] inbox_id mismatch subjectId=${subjectId} expected=${owner.chatwootInboxId} got=${convInboxId} — skipping`);
    return;
  }

  // Is a human currently assigned?
  const assigneeId = conv.assignee_id ?? conv.meta?.assignee?.id ?? payload.assignee_id ?? payload.meta?.assignee?.id ?? null;
  const assigned = !!conv.assignee || !!conv.meta?.assignee || !!payload.assignee || !!payload.meta?.assignee || !!assigneeId;
  const status = String(conv.status ?? payload.status ?? '');
  const resolved = status === 'resolved';
  const humanActive = assigned && !resolved;
  // Diagnostic: the exact payload shape varies by Chatwoot version/event — log what we parsed.
  console.log(`[handoff] event=${payload.event} status=${status} assigned=${assigned} assigneeId=${assigneeId} resolved=${resolved} → ${humanActive ? 'PAUSE' : 'RESUME'}`);

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
    // On resolve, also UNASSIGN the conversation (set to "none") so it's clean for next time —
    // assignment is the single source of truth for handoff (you asked for exactly this).
    if (resolved && assigned) {
      try {
        const db = await getDb();
        const t = await db.collection('tenants').findOne({ _id: tenantId } as Record<string, unknown>) as { chatwoot?: { accountId: number; apiKey: string } } | null;
        if (t?.chatwoot?.accountId && t.chatwoot.apiKey) {
          const cwUrl = (process.env.CHATWOOT_URL ?? '').replace(/\/$/, '');
          const r = await fetch(`${cwUrl}/api/v1/accounts/${t.chatwoot.accountId}/conversations/${convId}/assignments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api_access_token': t.chatwoot.apiKey },
            body: JSON.stringify({ assignee_id: null }),
          });
          console.log(`[handoff] unassign-on-resolve conv=${convId}: ${r.status}`);
        }
      } catch (e) { console.warn('[handoff] unassign-on-resolve failed:', String(e)); }
    }
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
    { projection: { _id: 1, tenantId: 1, priority: 1, contactFilter: 1, groupConfig: 1, status: 1, chatwootInboxId: 1 } },
  ).toArray()) as unknown as Array<RoutableAgent & { status?: string; chatwootInboxId?: number }>;
  // Only active/pending agents participate; sort by priority asc, stable by id.
  const ordered = agents
    .filter(a => a.status !== 'paused')
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || String(a._id).localeCompare(String(b._id)));

  if (ordered.length === 0) {
    console.warn(`[ev-webhook] no agent found for instance=${instance}`);
    return;
  }
  const tenantId = ordered[0].tenantId;

  // Chatwoot creds (for instant incoming mirroring — no debounce delay).
  const tenantDoc = await db.collection('tenants').findOne({ _id: tenantId } as Record<string, unknown>) as { chatwoot?: { accountId: number; apiKey: string } } | null;
  const cwAccountId = tenantDoc?.chatwoot?.accountId?.toString() ?? '';
  const cwApiKey = tenantDoc?.chatwoot?.apiKey ?? '';

  for (const msg of rawMsgs) {
    const key = (msg.key ?? {}) as Record<string, unknown>;
    const jidEarly = String(key.remoteJid ?? '');
    if (key.fromMe) {
      // Learn the bot's OWN identity inside groups (phone or @lid) from its outgoing messages, so
      // we can recognize @mentions / replies addressed to it (WhatsApp uses @lid, not the phone).
      if (jidEarly.endsWith('@g.us') && key.participant) {
        const botId = String(key.participant).replace(/@[^@]+$/, '').replace(/\D/g, '');
        if (botId) {
          await redis.sadd(`bot_ids:${instance}`, botId);
          await redis.expire(`bot_ids:${instance}`, 60 * 60 * 24 * 60);
        }
      }
      continue; // skip our own outgoing messages
    }

    const jid = jidEarly;
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
    // In "respond to all" groups the bot is a participant in the WHOLE conversation → shared thread.
    // Otherwise history is isolated PER participant (each member has their own thread with the bot).
    let groupRespondToAll = false;
    if (isGroup) {
      // Default per-field: an old/partial groupConfig (e.g. {} from a pre-schema agent) must still
      // respond to mentions/replies. An explicitly-set false is respected (false ?? true = false).
      const rawGc = (owner.groupConfig ?? {}) as Partial<GroupConfig>;
      const gc: GroupConfig = {
        respondToMentions: rawGc.respondToMentions ?? true,
        respondToReplies: rawGc.respondToReplies ?? true,
        respondToAll: rawGc.respondToAll ?? false,
      };
      groupRespondToAll = gc.respondToAll ?? false;
      // The bot can be addressed by its phone OR by a WhatsApp @lid. Match against both: the phone
      // from Evolution plus any group identities learned from the bot's own messages.
      const botPhone = await getAgentPhone(instance);
      const fromInstance = await getAgentIdentities(instance);
      const learned = await redis.smembers(`bot_ids:${instance}`).catch(() => [] as string[]);
      const botIds = [...new Set([botPhone, ...fromInstance, ...learned].filter((x): x is string => !!x))];
      // Do we know a @lid (anything beyond the plain phone)? If not, fall back to lenient mention.
      const haveLid = botIds.some(id => id !== botPhone);
      const idMatches = (p: string) => botIds.some(b => p === b || b.endsWith(p) || p.endsWith(b));
      const replyParticipant = (reply.participant ?? '').replace(/@[^@]+$/, '').replace(/\D/g, '');
      // A reply counts as "to the bot" if it quotes a message the bot actually sent (authoritative,
      // @lid-independent) OR, as a fallback, the quoted author matches a known bot identity.
      const repliesBotMsg = !!reply.stanzaId && (await redis.sismember(`bot_sent:${instance}`, reply.stanzaId).catch(() => 0)) === 1;
      // ONLY a reply to the bot's OWN message counts. Authoritative: the quoted id is one the bot
      // sent (bot_sent). Secondary: the quoted author matches the bot's known @lid (covers messages
      // sent before tracking began). NO loose fallback — that made it answer replies to anyone.
      const replyToBot = repliesBotMsg || (!!replyParticipant && idMatches(replyParticipant));
      // When we KNOW this reply quotes a bot message, its quoted author is the bot's @lid — learn
      // it so future mentions/replies match precisely (no more lenient fallback).
      if (repliesBotMsg && replyParticipant && !idMatches(replyParticipant)) {
        await redis.sadd(`bot_ids:${instance}`, replyParticipant).catch(() => {});
        await redis.expire(`bot_ids:${instance}`, 60 * 60 * 24 * 60).catch(() => {});
      }
      const gate = groupFilter({
        jid,
        messageText: cheapText(message), // text only — audio NOT transcribed yet
        waExternalId: replyToBot ? reply.stanzaId : null,
        agentPhones: botIds,
        senderPhone,
        mentionedPhones: extractMentionedPhones(message),
        lenientMention: !haveLid,
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
    // Audio is kept SEPARATE from mediaBase64: the transcript feeds the LLM, but we still want
    // the actual voice note mirrored to Chatwoot as a playable attachment (not text-only).
    let audioB64: string | undefined;
    let audioMime: string | undefined;
    let audioTranscript = '';

    const media = classifyEvolutionMedia(message);
    if (media) {
      if (media.caption && !text) text = media.caption;
      if (media.kind === 'audio') {
        userSentAudio = true;
        const fetched = await fetchEvolutionMediaBase64(instance, msg);
        if (fetched) {
          audioB64 = fetched.base64;
          audioMime = fetched.mimetype ?? media.mimetype;
          audioTranscript = await transcribeAudio(fetched.base64, audioMime);
          text = [text, audioTranscript].filter(Boolean).join('\n') || '[Áudio sem fala reconhecível]';
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

    // Conversation key: per-contact for direct chats; for groups, per-member (isolated history) —
    // EXCEPT "respond to all" groups, where the bot follows the whole group as one shared thread.
    const groupSan = jid.replace(/[^a-z0-9]/gi, '_');
    const convKey = isGroup ? (groupRespondToAll ? groupSan : `${groupSan}_${senderPhone}`) : groupSan;
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

    // ── Instant CRM mirror: post the customer's message to Chatwoot NOW (no debounce delay). ──
    if (owner.chatwootInboxId && cwAccountId && cwApiKey && (text || mediaBase64 || audioB64)) {
      try {
        const cid = await resolveOrCreateConversation(cwAccountId, cwApiKey, owner.chatwootInboxId, senderPhone, pushName || senderPhone || 'Usuário', jid);
        if (cid) {
          if (audioB64) {
            // Mirror the real voice note (playable) + the transcript as a private note.
            const ext = (audioMime ?? '').includes('mpeg') ? 'mp3' : (audioMime ?? '').includes('wav') ? 'wav' : 'ogg';
            await postChatwootMessage(cwAccountId, cwApiKey, cid, 'incoming', '', msgId, [{ base64: audioB64, mimetype: audioMime ?? 'audio/ogg', fileName: `audio.${ext}` }]);
            if (audioTranscript.trim()) await postChatwootNote(cwAccountId, cwApiKey, cid, `🗣️ Transcrição do áudio do cliente:\n${audioTranscript}`);
          } else {
            const media = mediaBase64 ? [{ base64: mediaBase64, mimetype: mediaMimetype ?? 'application/octet-stream', fileName: mediaFileName }] : [];
            await postChatwootMessage(cwAccountId, cwApiKey, cid, 'incoming', text, msgId, media);
          }
        }
      } catch (e) { console.error('[ev-webhook] instant mirror failed:', String(e)); }
    }

    scheduleDebounce(agentId, `ev:${convKey}`, tenantId);
  }
}
