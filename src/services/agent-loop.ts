/**
 * agent-loop.ts — LLM + tool execution loop (multi-tenant, pure function)
 * Replaces the /agent-loop HTTP endpoint and wf-executor-v1 N8N workflow.
 * Supports dynamic tool registry: built-in namespaces (toggleable) + custom HTTP APIs.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getRedis } from '../tools/redis.js';
import { CATALOG_BY_ID } from './tool-catalog.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { n8nTools, handleN8nTool } from '../tools/n8n.js';
import { evolutionTools, handleEvolutionTool } from '../tools/evolution.js';
import { chatwootTools, handleChatwootTool } from '../tools/chatwoot.js';
import { mongodbTools, handleMongodbTool } from '../tools/mongodb.js';
import { redisTools, handleRedisTool } from '../tools/redis.js';
import { qdrantTools, handleQdrantTool } from '../tools/qdrant.js';
import { coolifyTools, handleCoolifyTool } from '../tools/coolify.js';
import { intelligenceTools, handleIntelligenceTool } from '../tools/intelligence.js';
import { systemTools, handleSystemTool } from '../tools/system.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type OpenRouterMessage = {
  role: string;
  content: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
};

export interface CustomApi {
  name: string;
  description: string;
  url: string;
  method: string;
  headers?: { key: string; value: string }[];
  schema: Record<string, unknown>;
  /**
   * How the tool behaves:
   *  - 'responding' (default): the LLM waits for the result and composes the reply.
   *  - 'void': the agent runs it and just confirms to the contact (no payload back to the LLM).
   *  - 'async': fires the request, the agent tells the contact "estou verificando…", and the
   *    real answer arrives later via POST /webhook/tool-result/{token} → a follow-up message.
   */
  kind?: 'responding' | 'void' | 'async';
  /** For async tools: short label of what we're waiting on (used in the "verificando…" message). */
  waitingMessage?: string;
}

/** Per-agent content the actions draw from (never invented by the LLM). Everything is labeled. */
export interface AgentAssets {
  menus?: { label: string; intro?: string; options: string[] }[];
  reactions?: { label: string; emoji: string }[];
  stickers?: { label: string; url: string }[];
  labels?: { label: string }[]; // CRM conversation labels
  files?: { label: string; url: string; mediatype?: string; mimetype?: string; fileName?: string; caption?: string }[];
  locations?: { label: string; name: string; address: string; latitude: number; longitude: number }[];
  contacts?: { label: string; fullName: string; phone: string; organization?: string; email?: string; url?: string }[];
}

/** Normalize reactions: tolerate the legacy `string[]` (emoji-only) shape. */
function reactionList(assets: AgentAssets | undefined): { label: string; emoji: string }[] {
  const raw = (assets?.reactions ?? []) as unknown[];
  return raw
    .map(r => typeof r === 'string' ? { label: r, emoji: r } : (r as { label: string; emoji: string }))
    .filter(r => r && r.emoji);
}

/** Allowed values for an action's selector — always the configured item labels. */
function assetValues(kind: string, assets: AgentAssets | undefined): string[] {
  if (!assets) return [];
  if (kind === 'reactions') return reactionList(assets).map(r => r.label).filter(Boolean);
  const list = (assets as Record<string, Array<{ label?: string }>>)[kind] ?? [];
  return list.map(i => i.label ?? '').filter(Boolean);
}

export interface AgentConfig {
  model: string;
  temperature?: number;
  maxIter?: number;
  /** Built-in tool namespaces (advanced/admin). Messaging namespaces are never exposed to the LLM. */
  tools: string[];
  /** Enabled curated actions from the catalog, e.g. ['acao_enviar_enquete']. */
  builtinTools?: string[];
  /** Configured content the actions use. */
  assets?: AgentAssets;
  customApis: CustomApi[];
  chatwootAccountId?: string;
}

export interface AgentLoopContext {
  agentId: string;
  tenantId: string;
  instance: string;
  senderPhone: string;
  contactJid?: string;        // the ONLY destination actions may target (current contact)
  lastMessageId?: string;     // id of the contact's last message (for reactions)
  recentMessages?: { id: string; text: string }[]; // recent chat messages (react to any by snippet)
  chatwootConvId?: number;
  messages: OpenRouterMessage[];
  agent: AgentConfig;
}

export interface AgentLoopResult {
  content: string;
  toolCallsMade: boolean;
  escalate: boolean;
  /** CRM labels the agent applied to the current conversation (applied post-loop by the caller). */
  labels?: string[];
}

// ── Built-in tool registry ───────────────────────────────────────────────────

const BUILTIN_NAMESPACES: Record<string, Tool[]> = {
  n8n: n8nTools,
  evolution: evolutionTools,
  chatwoot: chatwootTools,
  mongo: mongodbTools,
  redis: redisTools,
  qdrant: qdrantTools,
  coolify: coolifyTools,
  intelligence: intelligenceTools,
  system: systemTools,
};

function mcpToOpenRouterTool(t: Tool) {
  return {
    type: 'function' as const,
    function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema },
  };
}

const BUSCAR_MEMORIA_TOOL = {
  type: 'function' as const,
  function: {
    name: 'buscar_memoria',
    description:
      'Busca informações relevantes na base de conhecimento do agente usando busca semântica. ' +
      'Use sempre que precisar de informações sobre produtos, políticas, procedimentos ou contexto do negócio.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Termos de busca para encontrar informações relevantes' },
      },
    },
  },
};

/** Clone an action's schema and fill ONLY the selector property's enum with allowed values. */
function withAssetEnum(params: Record<string, unknown>, prop: string, values: string[]): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(params)) as { properties?: Record<string, Record<string, unknown>> };
  if (clone.properties?.[prop]) clone.properties[prop] = { ...clone.properties[prop], enum: values };
  return clone as Record<string, unknown>;
}

function buildToolList(agent: AgentConfig) {
  const tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> = [BUSCAR_MEMORIA_TOOL];

  // Curated actions — the agent only chooses a PRE-CONFIGURED item; sensitive fields
  // (instance, destination number, message id) are injected at execution from context.
  for (const id of agent.builtinTools ?? []) {
    const cat = CATALOG_BY_ID.get(id);
    if (!cat) continue;
    const values = assetValues(cat.asset, agent.assets);
    if (values.length === 0) continue; // enabled but nothing configured → don't offer it
    const params = withAssetEnum(cat.params, cat.assetParam, values);
    tools.push({ type: 'function', function: { name: cat.id, description: `${cat.description} ${cat.example}`, parameters: params } });
  }

  // Advanced namespaces (admin only). Messaging namespaces are intentionally excluded so the
  // LLM can never send to an arbitrary number/instance.
  const safe = (agent.tools ?? []).filter(ns => ns !== 'evolution' && ns !== 'chatwoot');
  const nsTools = safe.flatMap(ns => BUILTIN_NAMESPACES[ns] ?? []).map(mcpToOpenRouterTool);
  tools.push(...nsTools);

  const customs = agent.customApis.map(api => ({
    type: 'function' as const,
    function: { name: api.name, description: api.description, parameters: api.schema },
  }));
  tools.push(...customs);
  return tools;
}

/** Build the real Evolution call for a curated action, injecting ALL sensitive fields from ctx. */
function buildCatalogCall(
  id: string,
  ctx: { instance: string; contactJid?: string; senderPhone: string; lastMessageId?: string; recentMessages?: { id: string; text: string }[] },
  args: Record<string, unknown>,
  assets: AgentAssets | undefined,
): { name: string; payload: Record<string, unknown> } | { error: string } {
  const instanceName = ctx.instance;
  const number = ctx.contactJid || ctx.senderPhone; // destination = current contact ONLY
  if (!number) return { error: 'sem destinatário' };

  switch (id) {
    case 'acao_enviar_menu': {
      const menu = (assets?.menus ?? []).find(m => m.label === args.menu);
      if (!menu) return { error: `menu "${String(args.menu)}" não cadastrado` };
      const opcoes = (menu.options ?? []).map(String).filter(Boolean);
      if (opcoes.length < 2) return { error: `menu "${menu.label}" precisa de 2+ opções` };
      // A numbered text menu — the most reliable cross-context "pick an option" UX.
      const numbered = opcoes.map((o, i) => `${i + 1}. ${o}`);
      const text = [menu.intro?.trim(), ...numbered].filter(Boolean).join('\n');
      return { name: 'evolution_send_text', payload: { instanceName, number, text } };
    }
    case 'acao_reagir': {
      const sel = String(args.reacao ?? '');
      // Tolerate the LLM passing either the label or the emoji itself (and legacy string config).
      const rcfg = reactionList(assets).find(r => r.label === sel || r.emoji === sel);
      if (!rcfg || !rcfg.emoji) return { error: `reação "${sel}" não cadastrada` };
      const emoji = rcfg.emoji;
      // Target priority: explicit message id → text snippet → the client's last message.
      let messageId = ctx.lastMessageId;
      const byId = args.mensagem_id ? String(args.mensagem_id).trim() : '';
      const ref = args.referencia ? String(args.referencia).toLowerCase().trim() : '';
      if (byId) {
        messageId = byId; // the LLM may target any message in the conversation by id
      } else if (ref) {
        const found = (ctx.recentMessages ?? []).find(m => {
          const t = (m.text ?? '').toLowerCase();
          return t.includes(ref) || (ref.length > 8 && t.length > 3 && ref.includes(t));
        });
        if (found) messageId = found.id;
      }
      if (!messageId) return { error: 'não há mensagem para reagir' };
      return { name: 'evolution_send_reaction', payload: {
        instanceName, remoteJid: number, fromMe: false, messageId, reaction: emoji,
      } };
    }
    case 'acao_enviar_figurinha': {
      const s = (assets?.stickers ?? []).find(x => x.label === args.figurinha);
      if (!s || !s.url) return { error: `figurinha "${String(args.figurinha)}" não cadastrada` };
      return { name: 'evolution_send_sticker', payload: { instanceName, number, sticker: s.url } };
    }
    case 'acao_enviar_arquivo': {
      const f = (assets?.files ?? []).find(x => x.label === args.arquivo);
      if (!f) return { error: `arquivo "${String(args.arquivo)}" não cadastrado` };
      return { name: 'evolution_send_media', payload: {
        instanceName, number, mediatype: f.mediatype || 'document', media: f.url,
        mimetype: f.mimetype, fileName: f.fileName || f.label, caption: f.caption,
      } };
    }
    case 'acao_enviar_localizacao': {
      const l = (assets?.locations ?? []).find(x => x.label === args.local);
      if (!l) return { error: `local "${String(args.local)}" não cadastrado` };
      return { name: 'evolution_send_location', payload: {
        instanceName, number, name: l.name, address: l.address, latitude: l.latitude, longitude: l.longitude,
      } };
    }
    case 'acao_enviar_contato': {
      const c = (assets?.contacts ?? []).find(x => x.label === args.contato);
      if (!c) return { error: `contato "${String(args.contato)}" não cadastrado` };
      const digits = String(c.phone ?? '').replace(/\D/g, '');
      return { name: 'evolution_send_contact', payload: {
        instanceName, number, contact: [{
          fullName: c.fullName, wuid: digits, phoneNumber: c.phone,
          organization: c.organization ?? '', email: c.email ?? '', url: c.url ?? '',
        }],
      } };
    }
  }
  return { error: 'ação desconhecida' };
}

// ── Routing ──────────────────────────────────────────────────────────────────

async function routeBuiltinTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name.startsWith('n8n_'))       return handleN8nTool(name, args);
  if (name.startsWith('evolution_')) return handleEvolutionTool(name, args);
  if (name.startsWith('chatwoot_'))  return handleChatwootTool(name, args);
  if (name.startsWith('mongo_'))     return handleMongodbTool(name, args);
  if (name.startsWith('redis_'))     return handleRedisTool(name, args);
  if (name.startsWith('qdrant_'))    return handleQdrantTool(name, args);
  if (name.startsWith('coolify_'))   return handleCoolifyTool(name, args);
  if (name.startsWith('intelligence_') || name.startsWith('customer_') || name.startsWith('business_'))
    return handleIntelligenceTool(name, args);
  if (name.startsWith('system_'))    return handleSystemTool(name, args);
  return `❌ Ferramenta não encontrada: ${name}`;
}

async function executeCustomApi(api: CustomApi, args: Record<string, unknown>): Promise<string> {
  const method = api.method.toUpperCase();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  for (const h of api.headers ?? []) {
    headers[h.key] = h.value;
  }
  let url = api.url;
  // Replace {param} placeholders in URL with arg values
  for (const [k, v] of Object.entries(args)) {
    url = url.replace(`{${k}}`, encodeURIComponent(String(v)));
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch(url, {
      method,
      headers,
      body: method !== 'GET' ? JSON.stringify(args) : undefined,
      signal: ctrl.signal,
    });
    const text = await r.text();
    return r.ok ? text : `❌ HTTP ${r.status}: ${text.slice(0, 300)}`;
  } finally {
    clearTimeout(t);
  }
}

// ── Self-loop detection ──────────────────────────────────────────────────────

const agentPhoneCache = new Map<string, string>();

export async function getAgentPhone(instance: string): Promise<string | null> {
  if (agentPhoneCache.has(instance)) return agentPhoneCache.get(instance)!;
  try {
    const r = await fetch(`${config.evolution.url}/instance/fetchInstances`, {
      headers: { apikey: config.evolution.apiKey, 'Content-Type': 'application/json' },
    });
    if (!r.ok) return null;
    const data = await r.json() as Array<{ name?: string; ownerJid?: string; number?: string }>;
    const inst = data.find(d => d.name === instance);
    const phone = (inst?.ownerJid ?? inst?.number ?? '').replace(/@[^@]+$/, '').replace(/\D/g, '') || null;
    if (phone) agentPhoneCache.set(instance, phone);
    return phone;
  } catch { return null; }
}

// ── buscar_memoria (RAG) ─────────────────────────────────────────────────────

async function executeBuscarMemoria(
  query: string,
  agentId: string,
  apiKey: string,
): Promise<string> {
  const collection = `agent_${agentId}`;
  const embModel = config.openrouter.embeddingModel;
  const qdrantUrl = config.qdrant.url.replace(/\/$/, '');
  const qdrantKey = config.qdrant.apiKey;

  // Embed query
  let embedding: number[] = [];
  try {
    const embCtrl = new AbortController();
    const et = setTimeout(() => embCtrl.abort(), 15_000);
    try {
      const er = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embModel, input: query }),
        signal: embCtrl.signal,
      });
      const ed = await er.json() as { data?: Array<{ embedding: number[] }> };
      embedding = ed.data?.[0]?.embedding ?? [];
    } finally { clearTimeout(et); }
  } catch (e) {
    return `Erro ao gerar embedding: ${String(e)}`;
  }

  if (embedding.length === 0) return 'Nenhuma informação relevante encontrada.';

  // Search Qdrant
  try {
    const qCtrl = new AbortController();
    const qt = setTimeout(() => qCtrl.abort(), 10_000);
    try {
      const qh: Record<string, string> = { 'Content-Type': 'application/json' };
      if (qdrantKey) qh['api-key'] = qdrantKey;
      const qr = await fetch(`${qdrantUrl}/collections/${collection}/points/search`, {
        method: 'POST', headers: qh, signal: qCtrl.signal,
        body: JSON.stringify({
          vector: embedding, limit: 5, with_payload: true, score_threshold: 0.35,
          filter: {
            should: [
              { key: 'agentId', match: { value: agentId } },
              { key: 'agentId', match: { value: 'global' } },
            ],
          },
        }),
      });
      const qd = await qr.json() as { result?: Array<{ score?: number; payload?: { content?: string; text?: string } }> };
      const hits = (qd.result ?? [])
        .filter(r => (r.score ?? 0) >= 0.35)
        .map(r => r.payload?.content || r.payload?.text || '')
        .filter(Boolean);
      return hits.length > 0 ? hits.join('\n\n') : 'Nenhuma informação relevante encontrada.';
    } finally { clearTimeout(qt); }
  } catch (e) {
    return `Erro ao buscar na base de conhecimento: ${String(e)}`;
  }
}

// ── Main loop ────────────────────────────────────────────────────────────────

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_TOOL_RESULT = 3000;
const ESCALATION_FLAG = '[ESCALAR_HUMANO]';

export async function agentLoop(ctx: AgentLoopContext): Promise<AgentLoopResult> {
  const { agentId, tenantId, instance, senderPhone, messages, agent } = ctx;
  const apiKey = config.openrouter.apiKey;
  const FALLBACK_MODEL = config.openrouter.fallbackModel;
  // No functional limit on tool rounds (that was an n8n constraint). A high safety
  // cap only guards against a runaway loop / runaway cost — never reached normally.
  const SAFETY_CAP = 100;

  // Self-loop detection: skip if the sender is the bot itself
  if (senderPhone && instance) {
    const agentPhone = await getAgentPhone(instance);
    if (agentPhone && (
      senderPhone === agentPhone ||
      agentPhone.endsWith(senderPhone) ||
      senderPhone.endsWith(agentPhone)
    )) {
      console.log(`[agent-loop] SKIP: self-loop senderPhone=${senderPhone} agentPhone=${agentPhone} (agent=${agentId})`);
      return { content: '[SKIP]', toolCallsMade: false, escalate: false };
    }
  }

  const tools = buildToolList(agent);

  // If the agent can react, let it target a specific message: show recent messages with
  // their ids right after the system prompt. (Reacting to an arbitrary message in the SAME
  // conversation is low-risk; the destination contact is still fixed by the platform.)
  if ((agent.builtinTools ?? []).includes('acao_reagir') && ctx.recentMessages?.length) {
    const lines = ctx.recentMessages.slice(0, 12)
      .map(m => `id=${m.id} → "${(m.text ?? '').slice(0, 80)}"`).join('\n');
    const note: OpenRouterMessage = {
      role: 'system',
      content: `Mensagens recentes desta conversa (mais novas primeiro). Para reagir a uma mensagem `
        + `específica, chame a ação de reagir com "mensagem_id" igual ao id exato abaixo. `
        + `Se omitir, a reação vai para a última mensagem do cliente.\n${lines}`,
    };
    if (messages[0]?.role === 'system') messages.splice(1, 0, note); else messages.unshift(note);
  }

  let modelInUse = agent.model;
  let currentBody: Record<string, unknown> = {
    model: modelInUse,
    temperature: agent.temperature ?? 0.3,
    messages,
    tools,
    tool_choice: 'auto',
  };
  const originalBody = { ...currentBody };

  let finalContent: string | null = null;
  let toolCallsMade = false;
  const ctxLog: string[] = [];
  // CRM labels the agent chose to apply (resolved post-loop by the caller).
  const appliedLabels = new Set<string>();
  // Text the model emits ALONGSIDE a tool call would otherwise be dropped (only the
  // final, tool-free message is returned). Collect it so nothing the agent "said" is lost.
  const preTexts: string[] = [];

  type LLMChoice = {
    finish_reason?: string;
    native_finish_reason?: string;
    message?: {
      content?: string;
      tool_calls?: Array<{ id: string; function?: { name: string; arguments: string } }>;
    };
  };

  for (let iter = 0; iter < SAFETY_CAP; iter++) {
    const msgs = Array.isArray(currentBody.messages) ? currentBody.messages as unknown[] : [];
    const ctxChars = JSON.stringify(msgs).length;
    ctxLog.push(`round${iter}:${ctxChars}chars`);

    // LLM call
    let llmData: Record<string, unknown>;
    let httpStatus = 0;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 60_000);
      try {
        const r = await fetch(OPENROUTER_URL, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(currentBody),
          signal: ctrl.signal,
        });
        httpStatus = r.status;
        llmData = await r.json() as Record<string, unknown>;
      } finally { clearTimeout(t); }
    } catch (e) {
      console.error(`[agent-loop] model=${modelInUse} iter=${iter} ctx=${ctxLog.join(',')} FETCH_ERROR:`, String(e));
      finalContent = 'Desculpe, erro ao conectar com o assistente. Tente novamente.';
      break;
    }

    // Provider error — try fallback model once
    if (llmData.error || !llmData.choices) {
      const errPayload = JSON.stringify(llmData).slice(0, 500);
      console.error(`[agent-loop] PROVIDER_ERROR model=${modelInUse} iter=${iter} http=${httpStatus} ctx=${ctxLog.join(',')} payload=${errPayload}`);

      if (modelInUse !== FALLBACK_MODEL) {
        console.error(`[agent-loop] Switching to fallback model ${FALLBACK_MODEL}`);
        modelInUse = FALLBACK_MODEL;
        currentBody = { ...originalBody, model: FALLBACK_MODEL };
        iter = -1;
        ctxLog.length = 0;
        toolCallsMade = false;
        continue;
      }

      finalContent = 'Desculpe, não consegui processar essa mensagem agora. Pode tentar novamente?';
      break;
    }

    const choice = (llmData.choices as LLMChoice[] | undefined)?.[0];
    const finish = choice?.finish_reason ?? '';
    const native = choice?.native_finish_reason ?? '';

    if (finish === 'error' || native.includes('MALFORMED')) {
      finalContent = 'Desculpe, não consegui processar essa mensagem. Pode tentar novamente?';
      break;
    }

    const toolCalls = choice?.message?.tool_calls ?? [];

    // No tool calls → final response
    if (toolCalls.length === 0) {
      finalContent = choice?.message?.content ?? 'Desculpe, erro interno.';
      break;
    }

    // Execute tool calls
    toolCallsMade = true;
    const assistantMsg = choice!.message!;
    // Capture any user-facing text the model wrote together with its tool call(s),
    // so it isn't lost (only the final tool-free message would otherwise be sent).
    const interim = typeof assistantMsg.content === 'string' ? assistantMsg.content.trim() : '';
    if (interim && preTexts[preTexts.length - 1] !== interim) preTexts.push(interim);
    const toolResults: Array<{ role: string; tool_call_id: string; content: string }> = [];
    const toolNames = toolCalls.map(tc => tc.function?.name ?? '?').join(',');
    console.log(`[agent-loop] model=${modelInUse} iter=${iter} ctx=${ctxChars}chars agent=${agentId} tenant=${tenantId} tools=[${toolNames}]`);

    for (const tc of toolCalls) {
      const toolName = tc.function?.name ?? '';
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function?.arguments ?? '{}'); } catch { /**/ }
      let content = '';

      try {
        if (toolName === 'buscar_memoria') {
          content = await executeBuscarMemoria(String(args.query ?? ''), agentId, apiKey);
        } else if (toolName === 'acao_etiquetar') {
          // CRM label — not a WhatsApp send. Validate against configured labels and queue
          // it; the caller applies it to the conversation after the loop. Invisible to the contact.
          const cfg = (agent.assets?.labels ?? []).find(l => l.label === args.etiqueta);
          if (!cfg) {
            content = `Não foi possível etiquetar: "${String(args.etiqueta)}" não está cadastrada. NÃO comente isso com o cliente.`;
          } else {
            appliedLabels.add(cfg.label);
            content = `Conversa etiquetada como "${cfg.label}". Isso é interno (CRM) — NÃO comente com o cliente; apenas continue o atendimento normalmente.`;
          }
        } else if (CATALOG_BY_ID.has(toolName)) {
          // Curated action — inject instance/destination/message id from context; the LLM
          // only chose the content. The destination is ALWAYS the current contact.
          const built = buildCatalogCall(
            toolName,
            { instance, contactJid: ctx.contactJid, senderPhone, lastMessageId: ctx.lastMessageId, recentMessages: ctx.recentMessages },
            args,
            agent.assets,
          );
          const label = CATALOG_BY_ID.get(toolName)?.label ?? toolName;
          if ('error' in built) {
            console.warn(`[agent-loop]   action=${toolName} BLOCKED: ${built.error} args=${JSON.stringify(args)}`);
            content = `Não foi possível executar "${label}": ${built.error}. Avise o cliente com naturalidade.`;
          } else {
            console.log(`[agent-loop]   action=${toolName} → ${built.name} payload=${JSON.stringify(built.payload).slice(0, 200)}`);
            const raw = await routeBuiltinTool(built.name, built.payload);
            content = raw.startsWith('❌')
              ? `A ação "${label}" falhou. Avise o cliente com gentileza, sem detalhes técnicos.`
              : `Ação "${label}" realizada com sucesso. Confirme ao cliente de forma natural e curta.`;
          }
        } else {
          // Check if it's a custom API
          const customApi = agent.customApis.find(a => a.name === toolName);
          if (customApi) {
            const kind = customApi.kind ?? 'responding';
            if (kind === 'async') {
              // Fire-and-acknowledge: register a callback token, fire the request, and
              // tell the LLM to reassure the contact. The real result arrives later.
              const token = randomUUID();
              await getRedis().set(
                `tool_pending:${token}`,
                JSON.stringify({
                  agentId, tenantId, instance,
                  contactJid: ctx.contactJid ?? '',
                  chatwootConvId: ctx.chatwootConvId ?? null,
                  toolName,
                }),
                'EX', 60 * 60 * 6, // 6h to receive the callback
              );
              const callbackUrl = `${config.app.url}/webhook/tool-result/${token}`;
              await executeCustomApi(customApi, { ...args, callback_url: callbackUrl }).catch(() => {});
              const waiting = customApi.waitingMessage || toolName;
              content = `[ASYNC] A ferramenta "${toolName}" foi acionada e está processando em segundo plano. `
                + `Diga ao cliente, de forma natural e curta, que você está verificando "${waiting}" e que retorna em breve. `
                + `NÃO invente o resultado — apenas confirme que está verificando.`;
            } else if (kind === 'void') {
              // Execute and just confirm — no payload returned to the LLM.
              const raw = await executeCustomApi(customApi, args);
              const failed = raw.startsWith('❌');
              content = failed
                ? `A ação "${toolName}" falhou: ${raw.slice(0, 200)}. Avise o cliente com gentileza.`
                : `A ação "${toolName}" foi executada com sucesso. Confirme ao cliente de forma natural e curta.`;
            } else {
              content = await executeCustomApi(customApi, args);
            }
          } else {
            const raw = await routeBuiltinTool(toolName, args);
            // Unwrap { ok, result } wrapper if present
            try {
              const p = JSON.parse(raw) as { ok?: boolean; result?: unknown; error?: unknown };
              content = p.ok === true
                ? (p.result !== undefined
                    ? (typeof p.result === 'string' ? p.result : JSON.stringify(p.result))
                    : raw)
                : p.ok === false
                  ? `Erro ferramenta: ${String(p.error ?? JSON.stringify(p))}`
                  : raw;
            } catch { content = raw; }
          }
        }
      } catch (e) {
        content = `Erro ao executar ${toolName}: ${String(e)}`;
      }

      if (content.length > MAX_TOOL_RESULT) {
        console.warn(`[agent-loop] tool=${toolName} result truncado ${content.length}->${MAX_TOOL_RESULT}chars`);
        content = content.slice(0, MAX_TOOL_RESULT) + '\n[resultado truncado]';
      }
      console.log(`[agent-loop]   tool=${toolName} result=${content.length}chars`);
      toolResults.push({ role: 'tool', tool_call_id: tc.id, content });
    }

    // Next round with accumulated context
    const prevMsgs: unknown[] = Array.isArray(currentBody.messages) ? currentBody.messages as unknown[] : [];
    currentBody = { ...currentBody, messages: [...prevMsgs, assistantMsg, ...toolResults] };
  }

  let content = finalContent ?? 'Desculpe, não consegui concluir. Tente novamente.';
  // Prepend any interim text the model wrote alongside tool calls (deduping the final).
  const pre = preTexts.filter(t => t && t.trim() && t.trim() !== content.trim());
  if (pre.length) content = [...pre, content].join('\n\n');
  const escalate = content.includes(ESCALATION_FLAG);

  return { content, toolCallsMade, escalate, labels: appliedLabels.size ? [...appliedLabels] : undefined };
}
