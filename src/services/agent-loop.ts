/**
 * agent-loop.ts — LLM + tool execution loop (multi-tenant, pure function)
 * Replaces the /agent-loop HTTP endpoint and wf-executor-v1 N8N workflow.
 * Supports dynamic tool registry: built-in namespaces (toggleable) + custom HTTP APIs.
 */
import { config } from '../config.js';
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
}

export interface AgentConfig {
  model: string;
  temperature?: number;
  maxIter?: number;
  /** Built-in tool namespaces enabled for this agent, e.g. ['evolution', 'chatwoot', 'mongo'] */
  tools: string[];
  customApis: CustomApi[];
  chatwootAccountId?: string;
}

export interface AgentLoopContext {
  agentId: string;
  tenantId: string;
  instance: string;
  senderPhone: string;
  chatwootConvId?: number;
  messages: OpenRouterMessage[];
  agent: AgentConfig;
}

export interface AgentLoopResult {
  content: string;
  toolCallsMade: boolean;
  escalate: boolean;
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

function buildToolList(agent: AgentConfig) {
  const builtins = agent.tools.flatMap(ns => BUILTIN_NAMESPACES[ns] ?? []).map(mcpToOpenRouterTool);
  const customs = agent.customApis.map(api => ({
    type: 'function' as const,
    function: { name: api.name, description: api.description, parameters: api.schema },
  }));
  return [BUSCAR_MEMORIA_TOOL, ...builtins, ...customs];
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

async function getAgentPhone(instance: string): Promise<string | null> {
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
  const MAX_ITER = agent.maxIter ?? 10;

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

  type LLMChoice = {
    finish_reason?: string;
    native_finish_reason?: string;
    message?: {
      content?: string;
      tool_calls?: Array<{ id: string; function?: { name: string; arguments: string } }>;
    };
  };

  for (let iter = 0; iter < MAX_ITER; iter++) {
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
        } else {
          // Check if it's a custom API
          const customApi = agent.customApis.find(a => a.name === toolName);
          if (customApi) {
            content = await executeCustomApi(customApi, args);
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

  const content = finalContent ?? 'Desculpe, não consegui concluir. Tente novamente.';
  const escalate = content.includes(ESCALATION_FLAG);

  return { content, toolCallsMade, escalate };
}
