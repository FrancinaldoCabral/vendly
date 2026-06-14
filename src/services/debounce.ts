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

const DEBOUNCE_MS = 12_000; // 12 s — allows for back-to-back typing before processing
const HISTORY_MAX = 40; // message pairs kept in Redis session

// Appended to every agent's system prompt — not overridable per agent.
// Teaches the LLM to output short WhatsApp-style messages separated by blank lines.
const WHATSAPP_STYLE_SUFFIX = `

---
IMPORTANTE: Você está respondendo via WhatsApp. Escreva respostas curtas e naturais.
- Divida respostas longas em partes curtas separadas por uma linha em branco.
- Nunca escreva parágrafos longos — máximo 3 linhas por mensagem.
- Use linguagem conversacional e informal.`;

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
    { role: 'system', content: agentDoc.systemPrompt + WHATSAPP_STYLE_SUFFIX },
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

  // Send response via Evolution API (chunked into short WhatsApp-style messages)
  const chunks = chunkMessage(content);
  for (let i = 0; i < chunks.length; i++) {
    await sendEvolutionText(instance, contactJid, chunks[i]);
    if (i < chunks.length - 1) await sleep(700);
  }

  // Sync to Chatwoot
  const cleanOutgoing = content.replace(/\[ESCALAR_HUMANO\]/g, '').trim();

  if (chatwootConvId) {
    // Chatwoot path: we know the conversation ID — use it directly
    await syncChatwootOutgoing(chatwootConvId, content, cwAccountId, cwApiKey);
  } else if (agentDoc.chatwootInboxId && cwAccountId && cwApiKey) {
    // Evolution path: no Chatwoot conv ID known — find/create contact+conversation and sync
    await sleep(1500); // brief wait so Evolution's own integration can create the conversation first
    await syncEvolutionToChaTwoot(
      contactJid,
      senderPhone,
      senderName,
      consolidatedText,
      cleanOutgoing,
      agentDoc.chatwootInboxId,
      cwAccountId,
      cwApiKey,
    );
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

/**
 * Split text into short WhatsApp-style message chunks.
 * Priority: double newlines → single newlines → sentence boundaries.
 * Max 280 chars per chunk (like a natural WhatsApp message).
 */
function chunkMessage(text: string, maxLen = 280): string[] {
  const clean = text.replace(/\[ESCALAR_HUMANO\]/g, '').trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];

  // Split on paragraph breaks first
  const blocks = clean.split(/\n\n+/).map(b => b.trim()).filter(Boolean);
  const result: string[] = [];

  for (const block of blocks) {
    if (block.length <= maxLen) {
      result.push(block);
      continue;
    }
    // Block too long → split on single newlines
    const lines = block.split(/\n/).map(l => l.trim()).filter(Boolean);
    let current = '';
    for (const line of lines) {
      const candidate = current ? `${current}\n${line}` : line;
      if (candidate.length <= maxLen) {
        current = candidate;
      } else {
        if (current) result.push(current);
        if (line.length <= maxLen) {
          current = line;
        } else {
          // Long unbroken line → split into multiple short pieces
          const pieces = splitLongText(line, maxLen);
          for (let p = 0; p < pieces.length - 1; p++) result.push(pieces[p]);
          current = pieces[pieces.length - 1] ?? '';
        }
      }
    }
    if (current) result.push(current);
  }

  return result.filter(c => c.length > 0);
}

/** Split a long unbroken string on sentence boundaries, returning multiple short pieces. */
function splitLongText(text: string, maxLen: number): string[] {
  const sentenceEnd = /(?<=[.!?])\s+/;
  const parts = text.split(sentenceEnd);
  const result: string[] = [];
  let acc = '';
  for (const part of parts) {
    const candidate = acc ? `${acc} ${part}` : part;
    if (candidate.length <= maxLen) {
      acc = candidate;
    } else {
      if (acc) result.push(acc);
      // Single sentence > maxLen — hard-cut
      acc = part.length <= maxLen ? part : part.slice(0, maxLen);
    }
  }
  if (acc) result.push(acc);
  return result.length > 0 ? result : [text.slice(0, maxLen)];
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

/**
 * Explicitly sync a WhatsApp exchange to Chatwoot when the Evolution-path processes a message.
 * Evolution's built-in Chatwoot integration may not mirror outgoing messages sent via sendText,
 * so we do it ourselves to guarantee conversations appear in the CRM.
 *
 * Logic:
 *  - Find or create Chatwoot contact by phone
 *  - If no open conversation exists for this inbox → create it AND add the incoming message
 *    (means Evolution didn't mirror it; we fill the gap)
 *  - Always add our outgoing response (Evolution never mirrors sendText → Chatwoot for this)
 */
async function syncEvolutionToChaTwoot(
  contactJid: string,
  senderPhone: string,
  senderName: string,
  incomingText: string,
  outgoingText: string,
  inboxId: number,
  accountId: string,
  apiKey: string,
): Promise<void> {
  if (!accountId || !apiKey || !inboxId) return;

  const cwUrl = config.chatwoot.url.replace(/\/$/, '');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'api_access_token': apiKey,
  };

  try {
    // 1. Find or create contact
    const phone = senderPhone
      ? (senderPhone.startsWith('+') ? senderPhone : `+${senderPhone}`)
      : '';
    let contactId: number | null = null;

    if (phone) {
      const bare = senderPhone.replace(/\D/g, '');
      const sr = await fetch(
        `${cwUrl}/api/v1/accounts/${accountId}/contacts/search?q=${encodeURIComponent(phone)}&page=1`,
        { headers },
      );
      if (sr.ok) {
        const data = await sr.json() as { payload?: Array<{ id: number; phone_number?: string }> };
        const found = (data.payload ?? []).find(c =>
          (c.phone_number ?? '').replace(/\D/g, '').endsWith(bare) ||
          bare.endsWith((c.phone_number ?? '').replace(/\D/g, '')),
        );
        contactId = found?.id ?? null;
      }
    }

    if (!contactId) {
      const cr = await fetch(`${cwUrl}/api/v1/accounts/${accountId}/contacts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: senderName || phone || 'Contato WhatsApp',
          phone_number: phone || undefined,
          identifier: contactJid || senderPhone || undefined,
        }),
      });
      if (cr.ok) {
        const c = await cr.json() as { id?: number };
        contactId = c.id ?? null;
      }
    }

    if (!contactId) {
      console.warn('[debounce] Chatwoot sync: could not find/create contact');
      return;
    }

    // 2. Find open conversation for this contact in our inbox
    let convId: number | null = null;
    const convsRes = await fetch(
      `${cwUrl}/api/v1/accounts/${accountId}/contacts/${contactId}/conversations`,
      { headers },
    );
    if (convsRes.ok) {
      const data = await convsRes.json() as {
        payload?: Array<{ id: number; inbox_id: number; status: string }>;
      };
      const open = (data.payload ?? []).find(
        c => c.inbox_id === inboxId && c.status !== 'resolved',
      );
      convId = open?.id ?? null;
    }

    const isNewConv = !convId;
    if (!convId) {
      const ccr = await fetch(`${cwUrl}/api/v1/accounts/${accountId}/conversations`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ inbox_id: inboxId, contact_id: contactId, status: 'open' }),
      });
      if (ccr.ok) {
        const conv = await ccr.json() as { id?: number };
        convId = conv.id ?? null;
      }
    }

    if (!convId) {
      console.warn('[debounce] Chatwoot sync: could not find/create conversation');
      return;
    }

    // 3. Add incoming message only when we created the conversation
    //    (if Evolution already mirrored it, the conversation already existed → skip to avoid dup)
    if (isNewConv && incomingText) {
      await fetch(`${cwUrl}/api/v1/accounts/${accountId}/conversations/${convId}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: incomingText, message_type: 'incoming', private: false }),
      });
    }

    // 4. Always add outgoing — Evolution sendText does NOT mirror to Chatwoot
    if (outgoingText) {
      await fetch(`${cwUrl}/api/v1/accounts/${accountId}/conversations/${convId}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: outgoingText, message_type: 'outgoing', private: false }),
      });
    }

    console.log(`[debounce] Chatwoot synced: contact=${contactId} conv=${convId} newConv=${isNewConv}`);
  } catch (e) {
    console.error('[debounce] Chatwoot explicit sync failed:', String(e));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
