import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { MongoClient, type Db } from 'mongodb';
import { config } from '../config.js';
import { createClient, safeRequest, toText } from '../utils/http.js';
import { randomUUID } from 'crypto';

let _mongoClient: MongoClient | null = null;
async function getMongo(): Promise<Db> {
  if (!_mongoClient) {
    _mongoClient = new MongoClient(config.mongodb.uri, { connectTimeoutMS: 10_000, serverSelectionTimeoutMS: 10_000 });
    await _mongoClient.connect();
  }
  return _mongoClient.db('saas_platform');
}

// Colection per-agent: agent_{agentId}
function qdrant() {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.qdrant.apiKey) headers['api-key'] = config.qdrant.apiKey;
  return createClient(config.qdrant.url, headers);
}

async function embed(text: string): Promise<number[]> {
  const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openrouter.apiKey}`,
    },
    body: JSON.stringify({ model: config.openrouter.embeddingModel, input: text.slice(0, 8000) }),
  });
  if (!res.ok) throw new Error(`Embedding API error: ${res.status} ${await res.text()}`);
  const data = await res.json() as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

export const intelligenceTools: Tool[] = [
  {
    name: 'intelligence_add',
    description: 'Adiciona um bloco de conhecimento ao Qdrant (produto, FAQ, política, etc.). Automaticamente vetorizado para busca semântica.',
    inputSchema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: { type: 'string', description: 'Texto do bloco de conhecimento' },
        type: { type: 'string', description: 'Tipo: produto, faq, politica, insight, resumo, etc.' },
        agentId: { type: 'string', description: 'ID do agente (colection agent_{agentId})' },
        collection: { type: 'string', description: 'Nome da coleção Qdrant (opcional, substitui agentId)' },
        phone: { type: 'string', description: 'Telefone do cliente (se for conhecimento específico)' },
      },
    },
  },
  {
    name: 'intelligence_search',
    description: 'Busca semântica nos blocos de conhecimento do agente.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Texto de busca' },
        agentId: { type: 'string', description: 'ID do agente' },
        collection: { type: 'string', description: 'Nome da coleção (opcional)' },
        type: { type: 'string', description: 'Filtrar por tipo' },
        limit: { type: 'number', description: 'Máximo de resultados (padrão 5)' },
        score_threshold: { type: 'number', description: 'Score mínimo 0-1 (padrão 0.3)' },
      },
    },
  },
  {
    name: 'intelligence_list',
    description: 'Lista blocos de conhecimento sem busca vetorial.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        collection: { type: 'string' },
        type: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'intelligence_delete',
    description: 'Remove um bloco de conhecimento pelo ID.',
    inputSchema: {
      type: 'object',
      required: ['id', 'agentId'],
      properties: {
        id: { type: 'string', description: 'UUID do bloco' },
        agentId: { type: 'string' },
        collection: { type: 'string' },
      },
    },
  },
  {
    name: 'intelligence_update',
    description: 'Atualiza o conteúdo de um bloco existente (recalcula o vetor).',
    inputSchema: {
      type: 'object',
      required: ['id', 'content', 'agentId'],
      properties: {
        id: { type: 'string' },
        content: { type: 'string' },
        type: { type: 'string' },
        agentId: { type: 'string' },
        collection: { type: 'string' },
      },
    },
  },
  // ── Clientes ──────────────────────────────────────────────────────────────────
  {
    name: 'customer_get',
    description: 'Busca o perfil de um cliente pelo phone (instância + telefone).',
    inputSchema: {
      type: 'object',
      required: ['instance', 'phone'],
      properties: {
        instance: { type: 'string' },
        phone: { type: 'string' },
        tenantId: { type: 'string', description: 'ID do tenant (opcional, para isolamento multi-tenant)' },
      },
    },
  },
  {
    name: 'customer_list',
    description: 'Lista clientes de uma instância com filtros.',
    inputSchema: {
      type: 'object',
      required: ['instance'],
      properties: {
        instance: { type: 'string' },
        tenantId: { type: 'string' },
        tag: { type: 'string' },
        limit: { type: 'number' },
        skip: { type: 'number' },
      },
    },
  },
  {
    name: 'customer_update_profile',
    description: 'Atualiza o perfil de um cliente (notas, preferências, tags).',
    inputSchema: {
      type: 'object',
      required: ['instance', 'phone'],
      properties: {
        instance: { type: 'string' },
        phone: { type: 'string' },
        tenantId: { type: 'string' },
        name: { type: 'string' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        preferences: { type: 'object' },
      },
    },
  },
  {
    name: 'customer_conversations',
    description: 'Lista conversas de um cliente.',
    inputSchema: {
      type: 'object',
      required: ['instance', 'phone'],
      properties: {
        instance: { type: 'string' },
        phone: { type: 'string' },
        tenantId: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  // ── Agentes/Negócios ───────────────────────────────────────────────────────────
  {
    name: 'business_get',
    description: 'Busca a configuração de um agente/negócio pelo nome da instância WhatsApp.',
    inputSchema: {
      type: 'object',
      required: ['instance'],
      properties: {
        instance: { type: 'string' },
        tenantId: { type: 'string' },
      },
    },
  },
  {
    name: 'business_upsert',
    description: 'Cria ou atualiza a configuração de um agente (systemPrompt, modelo, ferramentas).',
    inputSchema: {
      type: 'object',
      required: ['instance'],
      properties: {
        instance: { type: 'string' },
        name: { type: 'string' },
        systemPrompt: { type: 'string' },
        settings: { type: 'object' },
        active: { type: 'boolean' },
        tenantId: { type: 'string' },
      },
    },
  },
  {
    name: 'business_list',
    description: 'Lista todos os agentes/negócios cadastrados.',
    inputSchema: {
      type: 'object',
      properties: {
        active_only: { type: 'boolean' },
        tenantId: { type: 'string' },
      },
    },
  },
  {
    name: 'business_notify_list_get',
    description: 'Retorna a lista de números que recebem notificação de escalada humana.',
    inputSchema: {
      type: 'object',
      required: ['instance'],
      properties: { instance: { type: 'string' } },
    },
  },
  {
    name: 'business_notify_list_add',
    description: 'Adiciona um número à lista de notificação de escalada humana.',
    inputSchema: {
      type: 'object',
      required: ['instance', 'phone'],
      properties: {
        instance: { type: 'string' },
        phone: { type: 'string', description: '5521999999999 (apenas dígitos, com DDI)' },
      },
    },
  },
  {
    name: 'business_notify_list_remove',
    description: 'Remove um número da lista de notificação de escalada humana.',
    inputSchema: {
      type: 'object',
      required: ['instance', 'phone'],
      properties: {
        instance: { type: 'string' },
        phone: { type: 'string' },
      },
    },
  },
];

type Args = Record<string, unknown>;

function getCollection(args: Args): string {
  if (args.collection) return String(args.collection);
  if (args.agentId) return `agent_${args.agentId}`;
  return 'global_knowledge';
}

export async function handleIntelligenceTool(name: string, args: Args): Promise<string> {
  const q = qdrant();

  switch (name) {
    case 'intelligence_add': {
      const content = String(args.content);
      const vector = await embed(content);
      const id = randomUUID();
      const collection = getCollection(args);
      const payload = {
        content,
        type: args.type ?? 'geral',
        agentId: args.agentId ?? null,
        phone: args.phone ?? null,
        source: 'manual',
        created_at: Math.floor(Date.now() / 1000),
      };
      const res = await safeRequest(() =>
        q.put(`/collections/${collection}/points`, { points: [{ id, vector, payload }] }).then(r => r.data)
      );
      return toText('data' in res ? { data: { id, ...res.data } } : res);
    }

    case 'intelligence_search': {
      const vector = await embed(String(args.query));
      const collection = getCollection(args);
      const filter: Record<string, unknown> = {};
      const conditions: unknown[] = [];
      if (args.type) conditions.push({ key: 'type', match: { value: args.type } });
      if (conditions.length > 0) filter.must = conditions;
      const payload: Record<string, unknown> = {
        vector,
        limit: args.limit ?? 5,
        with_payload: true,
        score_threshold: args.score_threshold ?? 0.3,
      };
      if (conditions.length > 0) payload.filter = filter;
      const res = await safeRequest(() =>
        q.post(`/collections/${collection}/points/search`, payload).then(r => r.data)
      );
      return toText(res);
    }

    case 'intelligence_list': {
      const collection = getCollection(args);
      const conditions: unknown[] = [];
      if (args.type) conditions.push({ key: 'type', match: { value: args.type } });
      const body: Record<string, unknown> = {
        limit: args.limit ?? 20,
        with_payload: true,
        with_vector: false,
      };
      if (conditions.length > 0) body.filter = { must: conditions };
      const res = await safeRequest(() =>
        q.post(`/collections/${collection}/points/scroll`, body).then(r => r.data)
      );
      return toText(res);
    }

    case 'intelligence_delete': {
      const collection = getCollection(args);
      const res = await safeRequest(() =>
        q.post(`/collections/${collection}/points/delete`, { points: [args.id] }).then(r => r.data)
      );
      return toText(res);
    }

    case 'intelligence_update': {
      const content = String(args.content);
      const vector = await embed(content);
      const collection = getCollection(args);
      const existing = await safeRequest(() =>
        q.post(`/collections/${collection}/points`, { ids: [args.id], with_payload: true }).then(r => r.data)
      );
      const oldPayload = (existing as { result?: Array<{ payload?: Record<string, unknown> }> })?.result?.[0]?.payload ?? {};
      const newPayload = {
        ...oldPayload,
        content,
        ...(args.type ? { type: args.type } : {}),
        updated_at: Math.floor(Date.now() / 1000),
      };
      const res = await safeRequest(() =>
        q.put(`/collections/${collection}/points`, { points: [{ id: args.id, vector, payload: newPayload }] }).then(r => r.data)
      );
      return toText(res);
    }

    case 'customer_get': {
      const db = await getMongo();
      const filter: Record<string, unknown> = { instance: args.instance, phone: args.phone };
      if (args.tenantId) filter.tenantId = args.tenantId;
      const doc = await db.collection('customers').findOne(filter);
      return JSON.stringify(doc ?? { error: 'Cliente não encontrado' }, null, 2);
    }

    case 'customer_list': {
      const db = await getMongo();
      const filter: Record<string, unknown> = { instance: args.instance };
      if (args.tenantId) filter.tenantId = args.tenantId;
      if (args.tag) filter.tags = args.tag;
      const docs = await db.collection('customers')
        .find(filter)
        .sort({ last_seen: -1 })
        .limit(Number(args.limit ?? 20))
        .skip(Number(args.skip ?? 0))
        .toArray();
      return JSON.stringify(docs, null, 2);
    }

    case 'customer_update_profile': {
      const db = await getMongo();
      const setFields: Record<string, unknown> = { updated_at: new Date() };
      if (args.name) setFields.name = args.name;
      if (args.tags) setFields.tags = args.tags;
      if (args.preferences) setFields['profile.preferences'] = args.preferences;
      if (args.notes) setFields['profile.notes'] = args.notes;
      const filter: Record<string, unknown> = { instance: args.instance, phone: args.phone };
      if (args.tenantId) filter.tenantId = args.tenantId;
      const res = await db.collection('customers').updateOne(
        filter,
        { $set: setFields, $setOnInsert: { first_seen: new Date(), conversation_count: 0 } },
        { upsert: true }
      );
      return JSON.stringify(res, null, 2);
    }

    case 'customer_conversations': {
      const db = await getMongo();
      const filter: Record<string, unknown> = { instance: args.instance, phone: args.phone };
      if (args.tenantId) filter.tenantId = args.tenantId;
      const docs = await db.collection('conversations')
        .find(filter)
        .sort({ started_at: -1 })
        .limit(Number(args.limit ?? 5))
        .toArray();
      return JSON.stringify(docs, null, 2);
    }

    case 'business_get': {
      const db = await getMongo();
      const filter: Record<string, unknown> = { instances: args.instance };
      if (args.tenantId) filter.tenantId = args.tenantId;
      const doc = await db.collection('agents').findOne(filter);
      return JSON.stringify(doc ?? { error: 'Agente não encontrado' }, null, 2);
    }

    case 'business_upsert': {
      const db = await getMongo();
      const setFields: Record<string, unknown> = { updated_at: new Date() };
      if (args.name) setFields.name = args.name;
      if (args.systemPrompt !== undefined) setFields.systemPrompt = args.systemPrompt;
      if (args.settings) setFields.settings = args.settings;
      if (args.active !== undefined) setFields.active = args.active;
      if (args.tenantId) setFields.tenantId = args.tenantId;
      const filter: Record<string, unknown> = { instances: args.instance };
      const res = await db.collection('agents').updateOne(
        filter,
        { $set: setFields, $setOnInsert: { instances: [args.instance], created_at: new Date() } },
        { upsert: true }
      );
      return JSON.stringify(res, null, 2);
    }

    case 'business_list': {
      const db = await getMongo();
      const filter: Record<string, unknown> = {};
      if (args.active_only) filter.active = true;
      if (args.tenantId) filter.tenantId = args.tenantId;
      const docs = await db.collection('agents').find(filter).sort({ name: 1 }).toArray();
      return JSON.stringify(docs, null, 2);
    }

    case 'business_notify_list_get': {
      const db = await getMongo();
      const doc = await db.collection('agents').findOne(
        { instances: args.instance },
        { projection: { name: 1, escalationNotifyList: 1 } },
      );
      if (!doc) return JSON.stringify({ error: 'Agente não encontrado para instância: ' + args.instance });
      return JSON.stringify({ name: doc.name, escalationNotifyList: doc.escalationNotifyList ?? [] }, null, 2);
    }

    case 'business_notify_list_add': {
      const phone = String(args.phone).replace(/\D/g, '');
      if (!phone) return '❌ Número inválido';
      const db = await getMongo();
      const res = await db.collection('agents').updateOne(
        { instances: args.instance },
        { $addToSet: { escalationNotifyList: phone } as Record<string, unknown>, $set: { updated_at: new Date() } },
      );
      if (res.matchedCount === 0) return JSON.stringify({ error: 'Agente não encontrado para instância: ' + args.instance });
      const doc = await db.collection('agents').findOne(
        { instances: args.instance },
        { projection: { name: 1, escalationNotifyList: 1 } },
      );
      return JSON.stringify({ ok: true, name: doc?.name, escalationNotifyList: doc?.escalationNotifyList ?? [] }, null, 2);
    }

    case 'business_notify_list_remove': {
      const phone = String(args.phone).replace(/\D/g, '');
      if (!phone) return '❌ Número inválido';
      const db = await getMongo();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db.collection('agents') as any).updateOne(
        { instances: args.instance },
        { $pull: { escalationNotifyList: phone }, $set: { updated_at: new Date() } },
      );
      const doc = await db.collection('agents').findOne(
        { instances: args.instance },
        { projection: { name: 1, escalationNotifyList: 1 } },
      );
      return JSON.stringify({ ok: true, name: doc?.name, escalationNotifyList: doc?.escalationNotifyList ?? [] }, null, 2);
    }

    default:
      return `❌ Ferramenta não encontrada: ${name}`;
  }
}
