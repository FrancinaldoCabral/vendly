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
import { generateTts, buildMediaContentPart, type MediaKind } from './media.js';

const DEBOUNCE_MS = 12_000; // 12 s — allows for back-to-back typing before processing
const MAX_STORED_MESSAGES = 500; // hard safety cap on stored turns (summary keeps meaning)

// Appended to every agent's system prompt — not overridable per agent.
// Teaches the LLM to output short WhatsApp-style messages separated by blank lines.
const WHATSAPP_STYLE_SUFFIX = `

---
IMPORTANTE: Você está respondendo via WhatsApp. Escreva respostas curtas e naturais.
- Divida respostas longas em partes curtas separadas por uma linha em branco.
- Nunca escreva parágrafos longos — máximo 3 linhas por mensagem.
- Use linguagem conversacional e informal.`;

// Default capabilities — embedded in every agent, invisible to the user.
// The client must NOT have to teach the agent that it can hear/see/send audio:
// the platform handles media in/out automatically; the model only needs to know
// it is allowed, so it never wrongly refuses.
const CAPABILITIES_SUFFIX = `

---
SUAS CAPACIDADES (já habilitadas pela plataforma — nunca diga que não consegue):
- Você OUVE áudios: mensagens de voz do cliente já chegam transcritas para você.
- Você LÊ imagens, fotos, PDFs, documentos e vídeos que o cliente enviar.
- Você RESPONDE com mensagem de voz (áudio). Quando o cliente te envia um áudio,
  ou pede para você responder em áudio/voz, basta escrever sua resposta normalmente
  que a plataforma a converte e envia como áudio automaticamente.
- NUNCA afirme que não pode ouvir, ver, ler ou enviar áudio/mídia — você pode.
  Não mencione detalhes técnicos; apenas atenda com naturalidade.`;

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
  builtinTools?: string[];
  assets?: {
    menus?: Array<{ label: string; intro?: string; options: string[]; buttonText?: string; footerText?: string }>;
    reactions?: Array<{ label: string; emoji: string }>;
    stickers?: Array<{ label: string; url: string }>;
    labels?: Array<{ label: string }>;
    files?: Array<{ label: string; url: string; mediatype?: string; mimetype?: string; fileName?: string; caption?: string }>;
    locations?: Array<{ label: string; name: string; address: string; latitude: number; longitude: number }>;
    contacts?: Array<{ label: string; fullName: string; phone: string; organization?: string; email?: string; url?: string }>;
  };
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
    mediaUrl?: string;       // Chatwoot path: attachment data_url
    mediaType?: string;      // Chatwoot path: attachment file_type
    mediaBase64?: string;    // Evolution path: downloaded media bytes
    mediaMimetype?: string;
    mediaKind?: MediaKind;
    mediaFileName?: string;
    userSentAudio?: boolean; // client sent a voice message → mirror with audio
    senderName?: string;
    senderPhone?: string;
    contactJid?: string;
    messageId?: string;      // WA id of the incoming message (for reactions)
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

  // Recompute keys using JID when available — unifies Evolution + Chatwoot paths.
  // Groups get a per-member session scope so each group contact keeps its own history.
  const jidKey = contactJid ? contactJid.replace(/[^a-z0-9]/gi, '_') : '';
  const isGroupConv = contactJid.endsWith('@g.us');
  const sessionScope = isGroupConv && senderPhone ? `${jidKey}_${senderPhone}` : jidKey;
  const activeSessionKey = sessionScope ? `sessao:t:${tenantId}:${agentId}:${sessionScope}` : sessionKey;
  const activeTakeoverKey = jidKey ? `human_takeover:t:${tenantId}:${agentId}:${jidKey}` : takeoverKey;

  // Load agent config + tenant Chatwoot credentials (needed before mirroring).
  const db = await getDb();
  const agentDoc = await db.collection<AgentDoc>('agents').findOne({ _id: agentId, tenantId })
    ?? await db.collection<AgentDoc>('agents').findOne({ tenantId, evolutionInstance: { $exists: true } });
  if (!agentDoc) {
    console.error(`[debounce] Agent not found: agentId=${agentId} tenantId=${tenantId}`);
    return;
  }
  const tenantDoc = await db.collection<TenantDoc>('tenants').findOne({ _id: tenantId });
  const cwAccountId = tenantDoc?.chatwoot?.accountId?.toString() ?? agentDoc.chatwootAccountId ?? '';
  const cwApiKey = tenantDoc?.chatwoot?.apiKey ?? '';
  const instance = agentDoc.evolutionInstance;

  // Media attached to this turn (downloaded by the webhook).
  const mediaEntries = entries.filter(e => e.mediaBase64 && e.mediaKind);

  // ── Mirror the INCOMING message to Chatwoot ALWAYS — even if the bot is paused (human
  // takeover) or will skip. Otherwise the team can't see customer messages they need to handle.
  let cwConvId: number | null = chatwootConvId ?? null;
  if (agentDoc.chatwootInboxId && cwAccountId && cwApiKey) {
    cwConvId = await resolveOrCreateConversation(cwAccountId, cwApiKey, agentDoc.chatwootInboxId, senderPhone, senderName, contactJid);
    if (cwConvId && (consolidatedText || mediaEntries.length)) {
      const incomingMedia = mediaEntries.map(m => ({ base64: m.mediaBase64!, mimetype: m.mediaMimetype ?? 'application/octet-stream', fileName: m.mediaFileName }));
      await postChatwootMessage(cwAccountId, cwApiKey, cwConvId, 'incoming', consolidatedText, lastEntry.messageId ?? null, incomingMedia);
    }
  }

  // ── Bot gating (incoming is already mirrored above) ──
  // Human takeover: a human is handling this contact → the bot stays silent.
  const takenOver = (await redis.get(activeTakeoverKey)) || (activeTakeoverKey !== takeoverKey ? await redis.get(takeoverKey) : null);
  if (takenOver) {
    console.log(`[debounce] bot paused (human takeover) agent=${agentId} jid=${contactJid}`);
    return;
  }

  // Group filter (only applies to @g.us JIDs)
  if (isGroupConv && agentDoc.groupConfig) {
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
  const chatModel = agentDoc.model ?? config.openrouter.chatModel;
  // Keep a long memory; collapse older turns into a summary only when the window fills up.
  history = await summarizeIfNeeded(history, agentDoc.systemPrompt, chatModel);

  // Recent messages (id + text) so the agent can react to any message by snippet
  let recentMessages: { id: string; text: string }[] = [];
  try {
    const raw = await redis.lrange(`recent:t:${tenantId}:${conversationId}`, 0, 19);
    recentMessages = raw.map(r => { try { return JSON.parse(r) as { id: string; text: string }; } catch { return null; } })
      .filter((x): x is { id: string; text: string } => !!x && !!x.id);
  } catch { /* ignore */ }
  const lastMessageId = lastEntry.messageId ?? recentMessages[0]?.id;

  // Did the client speak (or ask for) audio? → mirror the reply in audio.
  const userSentAudio = entries.some(e => e.userSentAudio);
  const asksForAudio = /\b(á?udio|me\s+manda?\s+(um\s+)?(á?udio|voz)|responde?\s+(em\s+|por\s+|com\s+)?(á?udio|voz)|manda?\s+(em\s+|por\s+|um\s+)?(á?udio|voz))\b/i.test(consolidatedText);
  const replyInAudio = userSentAudio || asksForAudio;

  // Build user content (text + any attached media as multimodal parts)
  let userContent: unknown;
  if (mediaEntries.length > 0 || (lastEntry.mediaUrl && lastEntry.mediaType)) {
    const parts: unknown[] = [];
    if (consolidatedText) parts.push({ type: 'text', text: consolidatedText });
    for (const m of mediaEntries) {
      const part = buildMediaContentPart(
        m.mediaKind!, m.mediaBase64!, m.mediaMimetype ?? 'application/octet-stream', m.mediaFileName,
      );
      if (part) parts.push(part);
    }
    // Chatwoot path attachment (already a hosted URL)
    if (lastEntry.mediaUrl && lastEntry.mediaType) {
      parts.push({ type: 'image_url', image_url: { url: lastEntry.mediaUrl } });
    }
    userContent = parts.length ? parts : consolidatedText;
  } else {
    userContent = consolidatedText;
  }

  // When mirroring with audio, the reply is converted to speech — steer the model
  // toward natural spoken language (no markdown, no bullet symbols, spell things out).
  const audioNote = replyInAudio
    ? `\n\n---\nIMPORTANTE: Sua resposta será convertida em ÁUDIO (mensagem de voz). Escreva como se estivesse falando: linguagem natural, sem markdown, sem listas com símbolos, sem emojis. Frases faladas.`
    : '';

  // Build messages array: system + history + new user message
  const messages: OpenRouterMessage[] = [
    { role: 'system', content: agentDoc.systemPrompt + CAPABILITIES_SUFFIX + WHATSAPP_STYLE_SUFFIX + audioNote },
    ...history,
    { role: 'user', content: userContent },
  ];

  // Call agentLoop
  const loopCtx: AgentLoopContext = {
    agentId,
    tenantId,
    instance,
    senderPhone,
    contactJid,
    lastMessageId,
    recentMessages,
    chatwootConvId,
    messages,
    agent: {
      model: chatModel,
      temperature: agentDoc.temperature,
      maxIter: agentDoc.maxIter,
      tools: agentDoc.tools ?? [],
      builtinTools: agentDoc.builtinTools ?? [],
      assets: agentDoc.assets,
      customApis: agentDoc.customApis ?? [],
      chatwootAccountId: cwAccountId,
    },
  };

  let result: { content: string; toolCallsMade: boolean; escalate: boolean; labels?: string[] };
  try {
    result = await agentLoop(loopCtx);
  } catch (e) {
    console.error(`[debounce] agentLoop error agent=${agentId}:`, String(e));
    return;
  }

  const { content, escalate, labels } = result;

  // Skip signals
  if (content === '[SKIP]' || !content.trim()) {
    console.log(`[debounce] SKIP: loop returned [SKIP] or empty`);
    return;
  }

  // Mirror the client: if they spoke (or asked for) audio, reply with a voice note.
  // Falls back to text chunks if TTS fails.
  const cleanContent = content.replace(/\[ESCALAR_HUMANO\]/g, '').trim();
  let sentAsAudio = false;
  if (replyInAudio && cleanContent) {
    const tts = await generateTts(cleanContent);
    if (tts) {
      await sendEvolutionAudio(instance, contactJid, tts.base64);
      sentAsAudio = true;
      console.log(`[debounce] replied with audio agent=${agentId} conv=${conversationId}`);
    }
  }

  // Send response via Evolution API (chunked into short WhatsApp-style messages)
  const chunks = sentAsAudio ? [] : chunkMessage(content);
  const sentIds: (string | null)[] = [];
  for (let i = 0; i < chunks.length; i++) {
    sentIds.push(await sendEvolutionText(instance, contactJid, chunks[i]));
    if (i < chunks.length - 1) await sleep(700);
  }

  // Mirror the bot's OUTGOING reply to Chatwoot (incoming was already mirrored earlier).
  // source_id makes Chatwoot treat it as already-delivered → no "Failed to send", no re-delivery.
  const resolvedConvId = cwConvId;
  if (resolvedConvId && cwAccountId && cwApiKey) {
    const outgoing = sentAsAudio
      ? [{ text: cleanContent, sourceId: null as string | null }]
      : chunks.map((c, i) => ({ text: c, sourceId: sentIds[i] ?? null }));
    for (const out of outgoing) {
      if (out.text?.trim()) await postChatwootMessage(cwAccountId, cwApiKey, resolvedConvId, 'outgoing', out.text, out.sourceId, []);
    }
  }

  // Apply CRM labels the agent chose (ensure they exist, then merge onto the conversation).
  if (labels?.length) {
    if (resolvedConvId && cwAccountId && cwApiKey) {
      await applyChatwootLabels(resolvedConvId, labels, cwAccountId, cwApiKey);
    } else {
      console.warn(`[debounce] labels requested but no Chatwoot conversation resolved (agent=${agentId} phone=${senderPhone})`);
    }
  }

  // Escalation: assign to human team/agent
  if (escalate && resolvedConvId) {
    await escalateToHuman(
      resolvedConvId,
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

  // Update session history. Store the user turn as TEXT (never the base64 media bytes —
  // the model already saw them this turn; persisting them would bloat Redis and the window).
  const userHistoryText = consolidatedText
    || (mediaEntries.length ? '[o cliente enviou um arquivo/mídia]' : (userSentAudio ? '[o cliente enviou um áudio]' : ''));
  let newHistory: OpenRouterMessage[] = [
    ...history,
    { role: 'user', content: userHistoryText },
    { role: 'assistant', content },
  ];
  newHistory = await summarizeIfNeeded(newHistory, agentDoc.systemPrompt, chatModel);
  newHistory = capHistory(newHistory);
  await redis.set(activeSessionKey, JSON.stringify(newHistory), 'EX', 60 * 60 * 24 * 7); // 7 days

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

// ── Async tool result delivery ───────────────────────────────────────────────

/**
 * Called when an async tool POSTs its result to /webhook/tool-result/{token}.
 * Re-invokes the agent with the result injected and sends the follow-up reply,
 * honoring the golden rule (the conversation always ends with the agent).
 */
export async function handleToolResult(token: string, resultText: string): Promise<void> {
  const redis = getRedis();
  const raw = await redis.get(`tool_pending:${token}`);
  if (!raw) {
    console.log(`[tool-result] unknown/expired token=${token}`);
    return;
  }
  await redis.del(`tool_pending:${token}`);

  let p: { agentId: string; tenantId: string; instance: string; contactJid: string; chatwootConvId: number | null; toolName: string };
  try { p = JSON.parse(raw); } catch { return; }
  if (!p.contactJid) { console.warn(`[tool-result] token=${token} has no contactJid`); return; }

  const db = await getDb();
  const agentDoc = await db.collection<AgentDoc>('agents').findOne({ _id: p.agentId, tenantId: p.tenantId });
  if (!agentDoc) { console.error(`[tool-result] agent not found ${p.agentId}`); return; }

  const jidKey = p.contactJid.replace(/[^a-z0-9]/gi, '_');
  const activeSessionKey = `sessao:t:${p.tenantId}:${p.agentId}:${jidKey}`;
  const sessionRaw = await redis.get(activeSessionKey);
  let history: OpenRouterMessage[] = [];
  if (sessionRaw) { try { history = JSON.parse(sessionRaw) as OpenRouterMessage[]; } catch { /**/ } }

  const note = `[Resultado da ferramenta "${p.toolName}"]\n${resultText}\n\n`
    + `Responda agora ao cliente com base nesse resultado, de forma natural e curta.`;
  const messages: OpenRouterMessage[] = [
    { role: 'system', content: agentDoc.systemPrompt + CAPABILITIES_SUFFIX + WHATSAPP_STYLE_SUFFIX },
    ...history,
    { role: 'user', content: note },
  ];

  let result: { content: string; escalate: boolean };
  try {
    result = await agentLoop({
      agentId: p.agentId,
      tenantId: p.tenantId,
      instance: p.instance,
      senderPhone: '',
      contactJid: p.contactJid,
      chatwootConvId: p.chatwootConvId ?? undefined,
      messages,
      agent: {
        model: agentDoc.model ?? config.openrouter.chatModel,
        temperature: agentDoc.temperature,
        maxIter: agentDoc.maxIter,
        tools: agentDoc.tools ?? ['evolution', 'chatwoot'],
        builtinTools: agentDoc.builtinTools ?? [],
        customApis: agentDoc.customApis ?? [],
      },
    });
  } catch (e) {
    console.error(`[tool-result] agentLoop error:`, String(e));
    return;
  }

  const { content } = result;
  if (content === '[SKIP]' || !content.trim()) return;

  const chunks = chunkMessage(content);
  for (let i = 0; i < chunks.length; i++) {
    await sendEvolutionText(p.instance, p.contactJid, chunks[i]);
    if (i < chunks.length - 1) await sleep(700);
  }
  // No Chatwoot posting here — Evolution's integration mirrors the message we just sent.

  let newHistory: OpenRouterMessage[] = [...history, { role: 'user', content: note }, { role: 'assistant', content }];
  newHistory = capHistory(await summarizeIfNeeded(newHistory, agentDoc.systemPrompt, agentDoc.model ?? config.openrouter.chatModel));
  await redis.set(activeSessionKey, JSON.stringify(newHistory), 'EX', 60 * 60 * 24 * 7);
  console.log(`[tool-result] delivered token=${token} agent=${p.agentId} chunks=${chunks.length}`);
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

  // Every line break (single OR double) is a message boundary — this is what makes
  // the agent feel human on WhatsApp instead of dumping one big block. The system
  // prompt instructs the model to separate ideas with line breaks; here we honor them.
  const lines = clean.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const result: string[] = [];

  for (const line of lines) {
    if (line.length <= maxLen) {
      result.push(line);
    } else {
      // A single very long line with no breaks → split on sentence boundaries.
      for (const piece of splitLongText(line, maxLen)) result.push(piece);
    }
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

// ── Context window management ────────────────────────────────────────────────

/** Rough token estimate (~4 chars/token). Good enough to decide when to summarize. */
function estimateTokens(messages: unknown): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/** Hard safety cap on stored turns, preserving a leading summary if present. */
function capHistory(history: OpenRouterMessage[]): OpenRouterMessage[] {
  if (history.length <= MAX_STORED_MESSAGES) return history;
  const head = history[0]?.role === 'system' ? [history[0]] : [];
  return [...head, ...history.slice(-(MAX_STORED_MESSAGES - head.length))];
}

/**
 * Keep a long memory but collapse older turns into a concise summary once the window
 * (system prompt + history) reaches the configured ratio of the model's capacity
 * (default 70% of ~1M tokens). The most recent turns are always kept verbatim.
 */
async function summarizeIfNeeded(
  history: OpenRouterMessage[],
  systemPrompt: string,
  model: string,
): Promise<OpenRouterMessage[]> {
  const threshold = Math.floor(config.openrouter.contextWindowTokens * config.openrouter.summarizeAtRatio);
  const est = estimateTokens([{ role: 'system', content: systemPrompt }, ...history]);
  if (est < threshold) return history;

  const KEEP_RECENT = 16;
  if (history.length <= KEEP_RECENT + 2) return history; // too short to compress meaningfully
  const head = history.slice(0, history.length - KEEP_RECENT);
  const tail = history.slice(history.length - KEEP_RECENT);

  const summary = await callSummary(head, model);
  if (!summary) return history; // fail-safe: keep full history if summarization fails
  console.log(`[debounce] history summarized: ~${est} tokens >= ${threshold} → kept ${tail.length} recent turns + summary`);
  return [{ role: 'system', content: `[Resumo da conversa anterior — preserve estes fatos]\n${summary}` }, ...tail];
}

async function callSummary(messages: OpenRouterMessage[], model: string): Promise<string> {
  if (!config.openrouter.apiKey) return '';
  const convo = messages
    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : '[conteúdo não-textual]'}`)
    .join('\n')
    .slice(0, 200_000);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Authorization': `Bearer ${config.openrouter.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'Resuma a conversa a seguir de forma concisa, em português, preservando TODOS os fatos necessários para continuar o atendimento: nome e dados do cliente, preferências, decisões tomadas, pedidos/itens, valores, combinações e pendências. Não invente nada. Não adicione comentários — devolva só o resumo.' },
          { role: 'user', content: convo },
        ],
      }),
    });
    if (!r.ok) return '';
    const data = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
    return (data.choices?.[0]?.message?.content ?? '').trim();
  } catch {
    return '';
  } finally {
    clearTimeout(t);
  }
}

async function sendEvolutionText(instance: string, jid: string, text: string): Promise<string | null> {
  const url = `${config.evolution.url}/message/sendText/${instance}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.evolution.apiKey,
      },
      body: JSON.stringify({ number: jid, text }),
    });
    const data = await r.json().catch(() => null) as { key?: { id?: string } } | null;
    return data?.key?.id ?? null;
  } catch (e) {
    console.error(`[debounce] Evolution sendText failed:`, String(e));
    return null;
  }
}

/** Send a base64 audio payload as a WhatsApp voice note (PTT). */
async function sendEvolutionAudio(instance: string, jid: string, base64: string): Promise<void> {
  const url = `${config.evolution.url}/message/sendWhatsAppAudio/${instance}`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': config.evolution.apiKey },
      body: JSON.stringify({ number: jid, audio: base64 }),
    });
  } catch (e) {
    console.error(`[debounce] Evolution sendWhatsAppAudio failed:`, String(e));
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
 * Find (or create) the open Chatwoot conversation for a contact in our inbox. Read/create only —
 * no messages. Used to mirror incoming messages even when the bot is paused.
 */
async function resolveOrCreateConversation(
  accountId: string, apiKey: string, inboxId: number,
  senderPhone: string, senderName: string, contactJid: string,
): Promise<number | null> {
  if (!accountId || !apiKey || !inboxId) return null;
  const cwUrl = config.chatwoot.url.replace(/\/$/, '');
  const h = { 'Content-Type': 'application/json', 'api_access_token': apiKey };
  const bare = senderPhone.replace(/\D/g, '');
  const phone = bare ? `+${bare}` : '';
  try {
    let contactId: number | null = null;
    if (bare) {
      const sr = await fetch(`${cwUrl}/api/v1/accounts/${accountId}/contacts/search?q=${encodeURIComponent(bare)}&page=1`, { headers: h });
      if (sr.ok) {
        const d = await sr.json() as { payload?: Array<{ id: number; phone_number?: string }> };
        contactId = (d.payload ?? []).find(c => {
          const p = (c.phone_number ?? '').replace(/\D/g, '');
          return p && (p.endsWith(bare) || bare.endsWith(p));
        })?.id ?? null;
      }
    }
    if (!contactId) {
      const cr = await fetch(`${cwUrl}/api/v1/accounts/${accountId}/contacts`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ inbox_id: inboxId, name: senderName || phone || 'Contato', phone_number: phone || undefined, identifier: contactJid || bare || undefined }),
      });
      if (cr.ok) {
        const c = await cr.json() as { payload?: { contact?: { id?: number } }; id?: number };
        contactId = c.payload?.contact?.id ?? c.id ?? null;
      }
    }
    if (!contactId) { console.warn('[mirror] could not find/create contact'); return null; }

    let convId: number | null = null;
    const lc = await fetch(`${cwUrl}/api/v1/accounts/${accountId}/contacts/${contactId}/conversations`, { headers: h });
    if (lc.ok) {
      const d = await lc.json() as { payload?: Array<{ id: number; inbox_id: number; status: string }> };
      const convs = d.payload ?? [];
      convId = (convs.find(c => c.inbox_id === inboxId && c.status !== 'resolved') ?? convs.find(c => c.inbox_id === inboxId))?.id ?? null;
    }
    if (!convId) {
      const cc = await fetch(`${cwUrl}/api/v1/accounts/${accountId}/conversations`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ inbox_id: inboxId, contact_id: contactId, status: 'open', source_id: contactJid || bare }),
      });
      if (cc.ok) { const c = await cc.json() as { id?: number }; convId = c.id ?? null; }
    }
    if (!convId) console.warn('[mirror] could not find/create conversation');
    return convId;
  } catch (e) {
    console.error('[mirror] resolveOrCreateConversation failed:', String(e));
    return null;
  }
}

/**
 * Post one message into a Chatwoot conversation, with source_id so Chatwoot marks it delivered
 * (no "Failed to send") and never re-delivers. Media (incoming) is uploaded as attachments,
 * best-effort — a media failure falls back to posting the text only.
 */
async function postChatwootMessage(
  accountId: string, apiKey: string, conversationId: number,
  messageType: 'incoming' | 'outgoing', text: string, sourceId: string | null,
  media: Array<{ base64: string; mimetype: string; fileName?: string }>,
): Promise<void> {
  if (!accountId || !apiKey || !conversationId) return;
  const cwUrl = config.chatwoot.url.replace(/\/$/, '');
  const msgUrl = `${cwUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
  const jsonHeaders = { 'Content-Type': 'application/json', 'api_access_token': apiKey };
  try {
    if (media.length > 0) {
      try {
        const fd = new FormData();
        if (text) fd.append('content', text);
        fd.append('message_type', messageType);
        if (sourceId) fd.append('source_id', sourceId);
        for (const m of media) fd.append('attachments[]', new Blob([Buffer.from(m.base64, 'base64')], { type: m.mimetype }), m.fileName || 'arquivo');
        const r = await fetch(msgUrl, { method: 'POST', headers: { 'api_access_token': apiKey }, body: fd });
        if (!r.ok) {
          console.warn(`[mirror] ${messageType} media post ${r.status}: ${(await r.text()).slice(0, 150)}`);
          if (text) await fetch(msgUrl, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ content: text, message_type: messageType, source_id: sourceId ?? undefined }) });
        }
        return;
      } catch (e) {
        console.warn('[mirror] media upload failed, text only:', String(e));
      }
    }
    if (text) {
      const r = await fetch(msgUrl, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ content: text, message_type: messageType, source_id: sourceId ?? undefined }) });
      if (!r.ok) console.warn(`[mirror] ${messageType} post ${r.status}: ${(await r.text()).slice(0, 120)}`);
    }
  } catch (e) {
    console.error('[mirror] postChatwootMessage failed:', String(e));
  }
}

/**
 * Apply CRM labels to a Chatwoot conversation. Ensures each label exists at the account
 * level first (so it shows up properly), then MERGES with the conversation's existing labels
 * (the endpoint replaces the full set, so we fetch + union).
 */
async function applyChatwootLabels(
  conversationId: number,
  labels: string[],
  accountId: string,
  apiKey: string,
): Promise<void> {
  if (!accountId || !apiKey || !conversationId || labels.length === 0) return;
  const cwUrl = config.chatwoot.url.replace(/\/$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'api_access_token': apiKey };
  // Chatwoot label titles are lowercase/sluggy; normalize so create + apply match.
  const wanted = labels.map(l => l.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean);
  try {
    // 1. Ensure each label exists as an account label.
    const existingTitles = new Set<string>();
    const lr = await fetch(`${cwUrl}/api/v1/accounts/${accountId}/labels`, { headers });
    if (lr.ok) {
      const ld = await lr.json() as { payload?: Array<{ title: string }> };
      (ld.payload ?? []).forEach(l => existingTitles.add(l.title));
    }
    for (const t of wanted) {
      if (!existingTitles.has(t)) {
        const cr = await fetch(`${cwUrl}/api/v1/accounts/${accountId}/labels`, {
          method: 'POST', headers,
          body: JSON.stringify({ title: t, color: '#1f93ff', show_on_sidebar: true }),
        });
        console.log(`[debounce] Chatwoot label create "${t}": ${cr.status}`);
      }
    }

    // 2. Merge onto the conversation.
    const url = `${cwUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/labels`;
    let existing: string[] = [];
    const gr = await fetch(url, { headers });
    if (gr.ok) {
      const d = await gr.json() as { payload?: string[] };
      existing = Array.isArray(d.payload) ? d.payload : [];
    }
    const merged = Array.from(new Set([...existing, ...wanted]));
    const pr = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ labels: merged }) });
    const body = await pr.text();
    console.log(`[debounce] Chatwoot labels conv=${conversationId} status=${pr.status} labels=[${merged.join(',')}] resp=${body.slice(0, 150)}`);
  } catch (e) {
    console.error('[debounce] Chatwoot label apply failed:', String(e));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
