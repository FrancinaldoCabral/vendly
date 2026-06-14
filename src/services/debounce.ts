/**
 * debounce.ts — In-process debounce worker (replaces wf-debounce-v1 N8N workflow)
 * Buffers incoming messages per conversation, waits 5 s of silence, then
 * consolidates → loads context → calls agentLoop → sends reply → syncs Chatwoot.
 */
import { getRedis } from '../tools/redis.js';
import { getDb } from '../tools/mongodb.js';
import { config } from '../config.js';
import { agentLoop, type AgentLoopContext, type OpenRouterMessage } from './agent-loop.js';
import { groupFilter, type GroupConfig } from './group-filter.js';

const DEBOUNCE_MS = 5_000;
const HISTORY_MAX = 40; // message pairs kept in Redis session

// ── In-memory timer map ──────────────────────────────────────────────────────

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleDebounce(agentId: string, conversationId: string, tenantId: string): void {
  const key = `${tenantId}:${agentId}:${conversationId}`;
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(key, setTimeout(async () => {
    timers.delete(key);
    try {
      await processBuffer(agentId, conversationId, tenantId);
    } catch (e) {
      console.error(`[debounce] processBuffer error agent=${agentId} conv=${conversationId}:`, String(e));
    }
  }, DEBOUNCE_MS));
}

// ── MongoDB agent document shape (minimal) ──────────────────────────────────

interface AgentDoc {
  _id: string;
  tenantId: string;
  evolutionInstance: string;
  chatwootInboxId?: number;
  systemPrompt: string;
  assistantName?: string;
  model?: string;
  temperature?: number;
  maxIter?: number;
  tools?: string[];
  customApis?: Array<{
    name: string;
    description: string;
    url: string;
    method: string;
    headers?: { key: string; value: string }[];
    schema: Record<string, unknown>;
  }>;
  groupConfig?: GroupConfig;
  escalationTeamId?: number;
  escalationAgentId?: number;
  chatwootAccountId?: string;
}

interface TenantDoc {
  _id: string;
  chatwoot?: { accountId: number; apiKey: string };
}

interface ConversationDoc {
  agentId: string;
  tenantId: string;
  conversationId: string; // chatwoot conv id as string
  contactJid: string;
  senderPhone: string;
  waExternalId?: string;
  messageType?: string;
  mediaUrl?: string;
  createdAt?: Date;
}

// ── Buffer processing ────────────────────────────────────────────────────────

export async function processBuffer(agentId: string, conversationId: string, tenantId: string): Promise<void> {
  const redis = getRedis();
  const bufferKey = `buffer:t:${tenantId}:${conversationId}`;
  const sessionKey = `sessao:t:${tenantId}:${agentId}:${conversationId}`;
  const takeoverKey = `human_takeover:t:${tenantId}:${agentId}:${conversationId}`;

  // Initial takeover check using conversationId key (fast reject before reading buffer)
  const takeover = await redis.get(takeoverKey);
  if (takeover) {
    console.log(`[debounce] SKIP: human_takeover active agent=${agentId} conv=${conversationId}`);
    return;
  }

  // Pop all buffered messages
  const rawMessages: string[] = [];
  let msg: string | null;
  do {
    msg = await redis.rpop(bufferKey);
    if (msg) rawMessages.push(msg);
  } while (msg);

  if (rawMessages.length === 0) {
    console.log(`[debounce] SKIP: empty buffer agent=${agentId} conv=${conversationId}`);
    return;
  }

  // Parse buffered entries (JSON strings pushed by webhook service)
  interface BufferEntry {
    text?: string;
    mediaUrl?: string;
    mediaType?: string;
    senderName?: string;
    senderPhone?: string;
    contactJid?: string;
    waExternalId?: string;
    chatwootConvId?: number;
    timestamp?: number;
  }

  const entries: BufferEntry[] = rawMessages
    .map(r => { try { return JSON.parse(r) as BufferEntry; } catch { return { text: r }; } })
    .reverse(); // buffer is LIFO (LPUSH+RPOP), reverse to chronological

  // Consolidate text content
  const textParts = entries
    .map(e => e.text?.trim())
    .filter((t): t is string => !!t);
  const consolidatedText = textParts.join('\n');

  const lastEntry = entries[entries.length - 1];
  const senderPhone = String(lastEntry.senderPhone ?? '').replace(/\D/g, '');
  const contactJid = String(lastEntry.contactJid ?? '');
  const waExternalId = lastEntry.waExternalId ?? null;
  const chatwootConvId = lastEntry.chatwootConvId;
  const senderName = lastEntry.senderName ?? 'Usuário';

  if (!consolidatedText && !lastEntry.mediaUrl) {
    console.log(`[debounce] SKIP: no text/media agent=${agentId} conv=${conversationId}`);
    return;
  }

  // Recompute keys using JID when available — unifies Evolution + Chatwoot paths
  const jidKey = contactJid ? contactJid.replace(/[^a-z0-9]/gi, '_') : '';
  const activeSessionKey = jidKey ? `sessao:t:${tenantId}:${agentId}:${jidKey}` : sessionKey;
  const activeTakeoverKey = jidKey ? `human_takeover:t:${tenantId}:${agentId}:${jidKey}` : takeoverKey;

  // Second takeover check using JID key (covers human takeover from Chatwoot path)
  if (jidKey && activeTakeoverKey !== takeoverKey) {
    const jidTakeover = await redis.get(activeTakeoverKey);
    if (jidTakeover) {
      console.log(`[debounce] SKIP: human_takeover active (jid) agent=${agentId} jid=${contactJid}`);
      return;
    }
  }

  // Load agent config + tenant Chatwoot credentials
  const db = await getDb();
  const agentDoc = await db.collection<AgentDoc>('agents').findOne({ _id: agentId, tenantId })
    ?? await db.collection<AgentDoc>('agents').findOne({ tenantId, evolutionInstance: { $exists: true } });

  const tenantDoc = await db.collection<TenantDoc>('tenants').findOne({ _id: tenantId });
  const cwAccountId = tenantDoc?.chatwoot?.accountId?.toString() ?? agentDoc?.chatwootAccountId ?? '';
  const cwApiKey = tenantDoc?.chatwoot?.apiKey ?? '';

  if (!agentDoc) {
    console.error(`[debounce] Agent not found: agentId=${agentId} tenantId=${tenantId}`);
    return;
  }

  const instance = agentDoc.evolutionInstance;

  // Group filter (only applies to @g.us JIDs)
  if (contactJid.endsWith('@g.us') && agentDoc.groupConfig) {
    const filterResult = groupFilter({
      jid: contactJid,
      messageText: consolidatedText,
      waExternalId,
      agentPhone: null, // resolved by filter internally if needed
      senderPhone,
      groupConfig: agentDoc.groupConfig,
    });
    if (!filterResult.pass) {
      console.log(`[debounce] SKIP group filter: ${filterResult.reason}`);
      return;
    }
  }

  // Load session history from Redis (use JID-based key for unified history across both paths)
  const sessionRaw = await redis.get(activeSessionKey);
  let history: OpenRouterMessage[] = [];
  if (sessionRaw) {
    try { history = JSON.parse(sessionRaw) as OpenRouterMessage[]; } catch { /**/ }
  }

  // Build user content (handle text + optional media)
  let userContent: unknown;
  if (lastEntry.mediaUrl && lastEntry.mediaType) {
    const parts: unknown[] = [];
    if (consolidatedText) parts.push({ type: 'text', text: consolidatedText });
    parts.push({ type: 'image_url', image_url: { url: lastEntry.mediaUrl } });
    userContent = parts;
  } else {
    userContent = consolidatedText;
  }

  // Build messages array: system + history + new user message
  const messages: OpenRouterMessage[] = [
    { role: 'system', content: agentDoc.systemPrompt },
    ...history,
    { role: 'user', content: userContent },
  ];

  // Call agentLoop
  const loopCtx: AgentLoopContext = {
    agentId,
    tenantId,
    instance,
    senderPhone,
    chatwootConvId,
    messages,
    agent: {
      model: agentDoc.model ?? 'google/gemini-2.5-flash',
      temperature: agentDoc.temperature,
      maxIter: agentDoc.maxIter,
      tools: agentDoc.tools ?? ['evolution', 'chatwoot'],
      customApis: agentDoc.customApis ?? [],
      chatwootAccountId: cwAccountId,
    },
  };

  let result: { content: string; toolCallsMade: boolean; escalate: boolean };
  try {
    result = await agentLoop(loopCtx);
  } catch (e) {
    console.error(`[debounce] agentLoop error agent=${agentId}:`, String(e));
    return;
  }

  const { content, escalate } = result;

  // Skip signals
  if (content === '[SKIP]' || !content.trim()) {
    console.log(`[debounce] SKIP: loop returned [SKIP] or empty`);
    return;
  }

  // Send response via Evolution API (chunk by double newlines, max 4096 chars)
  const chunks = chunkMessage(content);
  for (const chunk of chunks) {
    await sendEvolutionText(instance, contactJid, chunk);
    if (chunks.length > 1) await sleep(400);
  }

  // Sync to Chatwoot (outgoing message)
  if (chatwootConvId) {
    await syncChatwootOutgoing(chatwootConvId, content, cwAccountId, cwApiKey);
  }

  // Escalation: assign to human team/agent
  if (escalate && chatwootConvId) {
    await escalateToHuman(
      chatwootConvId,
      agentDoc.escalationTeamId,
      agentDoc.escalationAgentId,
      cwAccountId,
      cwApiKey,
    );
    // Set takeover flag on both keys so both paths respect it
    await redis.set(activeTakeoverKey, '1', 'EX', 60 * 60 * 24); // 24h TTL
    if (activeTakeoverKey !== takeoverKey) {
      await redis.set(takeoverKey, '1', 'EX', 60 * 60 * 24);
    }
    console.log(`[debounce] ESCALATED agent=${agentId} conv=${conversationId}`);
  }

  // Update session history (JID-based key for unified history)
  const newHistory: OpenRouterMessage[] = [
    ...history,
    { role: 'user', content: userContent },
    { role: 'assistant', content },
  ];
  const trimmed = trimHistory(newHistory, HISTORY_MAX);
  await redis.set(activeSessionKey, JSON.stringify(trimmed), 'EX', 60 * 60 * 24 * 7); // 7 days

  // Persist conversation record
  await db.collection('conversations').insertOne({
    agentId,
    tenantId,
    conversationId: String(chatwootConvId ?? conversationId),
    contactJid,
    senderPhone,
    userMessage: consolidatedText,
    assistantMessage: content,
    escalated: escalate,
    createdAt: new Date(),
  } as ConversationDoc & Record<string, unknown>);

  console.log(`[debounce] DONE agent=${agentId} conv=${conversationId} chunks=${chunks.length} escalate=${escalate}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function chunkMessage(text: string, maxLen = 4096): string[] {
  // Remove escalation flag from visible output
  const clean = text.replace(/\[ESCALAR_HUMANO\]/g, '').trim();
  if (clean.length <= maxLen) return clean ? [clean] : [];

  const blocks = clean.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= maxLen) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = block.slice(0, maxLen);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function trimHistory(history: OpenRouterMessage[], maxPairs: number): OpenRouterMessage[] {
  // Keep only the last maxPairs user+assistant pairs (non-system messages)
  const pairs = history.filter(m => m.role === 'user' || m.role === 'assistant');
  if (pairs.length <= maxPairs * 2) return history;
  return pairs.slice(-maxPairs * 2);
}

async function sendEvolutionText(instance: string, jid: string, text: string): Promise<void> {
  const url = `${config.evolution.url}/message/sendText/${instance}`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.evolution.apiKey,
      },
      body: JSON.stringify({ number: jid, text }),
    });
  } catch (e) {
    console.error(`[debounce] Evolution sendText failed:`, String(e));
  }
}

async function syncChatwootOutgoing(
  conversationId: number,
  content: string,
  accountId: string,
  apiKey: string,
): Promise<void> {
  if (!accountId || !apiKey) return;
  const url = `${config.chatwoot.url}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
  const clean = content.replace(/\[ESCALAR_HUMANO\]/g, '').trim();
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api_access_token': apiKey },
      body: JSON.stringify({ content: clean, message_type: 'outgoing', private: false }),
    });
  } catch (e) {
    console.error(`[debounce] Chatwoot sync failed:`, String(e));
  }
}

async function escalateToHuman(
  conversationId: number,
  teamId?: number,
  assigneeId?: number,
  accountId?: string,
  apiKey?: string,
): Promise<void> {
  if (!accountId || !apiKey) return;
  const url = `${config.chatwoot.url}/api/v1/accounts/${accountId}/conversations/${conversationId}/assignments`;
  const payload: Record<string, unknown> = {};
  if (teamId) payload.team_id = teamId;
  if (assigneeId) payload.assignee_id = assigneeId;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api_access_token': apiKey },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error(`[debounce] Chatwoot escalation failed:`, String(e));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
