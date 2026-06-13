/**
 * system.ts — Ferramentas de manutenção do sistema (multi-tenant)
 * Limpeza de conversas: por contato ou tudo de um agente.
 * Opera sobre Chatwoot, Redis (sessao/buffer/debounce/human_takeover) e MongoDB.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config.js';
import { createClient, safeRequest } from '../utils/http.js';
import { getRedis } from './redis.js';
import { getDb } from './mongodb.js';

type Args = Record<string, unknown>;

function chatwootHttp() {
  return createClient(config.chatwoot.url, {
    api_access_token: config.chatwoot.apiKey,
    'Content-Type': 'application/json',
  });
}

const accountId = () => config.chatwoot.accountId;

// ── Helpers ─────────────────────────────────────────────────────────────────

async function deleteAllMessages(http: ReturnType<typeof chatwootHttp>, convId: number): Promise<number> {
  let deleted = 0;
  let beforeId: number | null = null;

  while (true) {
    const url = beforeId
      ? `/api/v1/accounts/${accountId()}/conversations/${convId}/messages?before_id=${beforeId}`
      : `/api/v1/accounts/${accountId()}/conversations/${convId}/messages`;

    const res = await safeRequest(() => http.get(url).then(r => r.data));
    const payload = (res as { payload?: unknown[] })?.payload ?? [];
    if (!Array.isArray(payload) || payload.length === 0) break;

    const ids = payload.map((m: unknown) => (m as { id: number }).id);
    for (const id of ids) {
      await safeRequest(() =>
        http.delete(`/api/v1/accounts/${accountId()}/conversations/${convId}/messages/${id}`).then(r => r.data)
      );
      deleted++;
    }
    if (payload.length < 25) break;
    beforeId = Math.min(...ids);
  }

  return deleted;
}

async function listAllChatwootConversationIds(http: ReturnType<typeof chatwootHttp>, inboxId?: number): Promise<number[]> {
  const ids: number[] = [];
  let page = 1;

  while (true) {
    const params: Record<string, unknown> = { page };
    if (inboxId) params.inbox_id = inboxId;
    const res = await safeRequest(() =>
      http.get(`/api/v1/accounts/${accountId()}/conversations`, { params }).then(r => r.data)
    );
    const data = (res as { data?: { payload?: unknown[] } })?.data?.payload ?? (res as { payload?: unknown[] })?.payload ?? [];
    if (!Array.isArray(data) || data.length === 0) break;
    ids.push(...data.map((c: unknown) => (c as { id: number }).id));
    if (data.length < 25) break;
    page++;
  }

  return ids;
}

async function deleteConversation(http: ReturnType<typeof chatwootHttp>, convId: number): Promise<boolean> {
  try {
    await safeRequest(() =>
      http.delete(`/api/v1/accounts/${accountId()}/conversations/${convId}`).then(r => r.data)
    );
    return true;
  } catch {
    return false;
  }
}

async function listAllChatwootContactIds(http: ReturnType<typeof chatwootHttp>): Promise<number[]> {
  const ids = new Set<number>();
  let page = 1;

  while (true) {
    const res = await safeRequest(() =>
      http.get(`/api/v1/accounts/${accountId()}/contacts`, { params: { page } }).then(r => r.data)
    );
    const data = (res as { data?: { payload?: unknown[] } })?.data?.payload
      ?? (res as { payload?: unknown[] })?.payload
      ?? [];
    if (!Array.isArray(data) || data.length === 0) break;
    data.forEach((c: unknown) => ids.add((c as { id: number }).id));
    if (data.length < 15) break;
    page++;
    if (page > 500) break;
  }

  return [...ids];
}

async function deleteContact(http: ReturnType<typeof chatwootHttp>, contactId: number): Promise<boolean> {
  try {
    await safeRequest(() =>
      http.delete(`/api/v1/accounts/${accountId()}/contacts/${contactId}`).then(r => r.data)
    );
    return true;
  } catch {
    return false;
  }
}

async function pMap<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const res = await Promise.allSettled(batch.map(fn));
    for (const r of res) {
      if (r.status === 'fulfilled') out.push(r.value);
    }
  }
  return out;
}

async function deleteRedisKeysByPattern(pattern: string): Promise<number> {
  const redis = getRedis();
  let cursor = '0';
  let deleted = 0;

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = nextCursor;
    if (keys.length > 0) {
      await redis.del(...keys);
      deleted += keys.length;
    }
  } while (cursor !== '0');

  return deleted;
}

async function deleteQdrantPoints(
  collection: string,
  filter: Record<string, unknown> | null,
): Promise<{ deleted: number; error?: string }> {
  try {
    if (!config.qdrant.url) return { deleted: 0, error: 'QDRANT_URL não configurado' };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.qdrant.apiKey) headers['api-key'] = config.qdrant.apiKey;
    const base = config.qdrant.url.replace(/\/$/, '');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);

    const infoRes = await fetch(`${base}/collections/${collection}`, { headers, signal: ctrl.signal });
    if (!infoRes.ok) {
      clearTimeout(t);
      return { deleted: 0, error: `coleção ${collection} inacessível (status ${infoRes.status})` };
    }

    let before = 0;
    try {
      const countRes = await fetch(`${base}/collections/${collection}/points/count`, {
        method: 'POST', headers, signal: ctrl.signal,
        body: JSON.stringify({ exact: true, ...(filter ? { filter } : {}) }),
      });
      if (countRes.ok) {
        const j = await countRes.json() as { result?: { count?: number } };
        before = j.result?.count ?? 0;
      }
    } catch { /* ignore */ }

    if (before === 0) { clearTimeout(t); return { deleted: 0 }; }

    const body = filter
      ? { filter }
      : { filter: { must_not: [{ key: '___never___', match: { value: '___never___' } }] } };

    const delRes = await fetch(`${base}/collections/${collection}/points/delete`, {
      method: 'POST', headers, signal: ctrl.signal, body: JSON.stringify(body),
    });
    clearTimeout(t);
    if (!delRes.ok) {
      const txt = await delRes.text().catch(() => '');
      return { deleted: 0, error: `delete falhou: ${delRes.status} ${txt.slice(0, 120)}` };
    }
    return { deleted: before };
  } catch (e) {
    return { deleted: 0, error: `qdrant indisponível: ${(e as Error)?.message ?? String(e)}` };
  }
}

// ── Definições de ferramentas ────────────────────────────────────────────────

export const systemTools: Tool[] = [
  {
    name: 'system_clear_contact',
    description:
      'Limpa TODOS os dados de um contato: mensagens do Chatwoot, chaves Redis (sessão, buffer, debounce, human_takeover) e documentos MongoDB. ' +
      'Passe o telefone no formato internacional (ex: 5511999999999).',
    inputSchema: {
      type: 'object',
      required: ['phone', 'tenantId'],
      properties: {
        phone: {
          type: 'string',
          description: 'Número do contato no formato internacional (ex: 5511999999999)',
        },
        tenantId: {
          type: 'string',
          description: 'ID do tenant para escopo das chaves Redis e documentos MongoDB',
        },
        agentId: {
          type: 'string',
          description: 'ID do agente — usado para escopo da coleção Qdrant (agent_{agentId})',
        },
        instance: {
          type: 'string',
          description: 'Filtrar chaves Redis por instância Evolution específica (opcional)',
        },
      },
    },
  },
  {
    name: 'system_clear_agent_conversations',
    description:
      'APAGA TUDO de um agente: conversas + contatos do Chatwoot (inbox do agente), chaves Redis ' +
      '(sessao/buffer/debounce/human_takeover), documentos MongoDB de conversations/customers, ' +
      'e memória vetorial Qdrant (agent_{agentId}). Preserva config do agente e knowledge base curada. Operação irreversível.',
    inputSchema: {
      type: 'object',
      required: ['agentId', 'tenantId'],
      properties: {
        agentId: { type: 'string', description: 'ID do agente' },
        tenantId: { type: 'string', description: 'ID do tenant' },
        chatwootInboxId: { type: 'number', description: 'ID da inbox Chatwoot do agente (opcional — filtra conversas)' },
      },
    },
  },
];

// ── Handlers ─────────────────────────────────────────────────────────────────

export async function handleSystemTool(name: string, args: Args): Promise<string> {
  switch (name) {
    case 'system_clear_contact': {
      const phone = String(args.phone ?? '').replace(/\D/g, '');
      const tenantId = String(args.tenantId ?? '');
      if (!phone) return '❌ Parâmetro "phone" obrigatório.';
      if (!tenantId) return '❌ Parâmetro "tenantId" obrigatório.';

      const results: string[] = [];

      // 1. Chatwoot
      try {
        const http = chatwootHttp();
        const searchRes = await safeRequest(() =>
          http.get(`/api/v1/accounts/${accountId()}/contacts/search`, { params: { q: phone, include_contacts: true } }).then(r => r.data)
        );
        const contacts: unknown[] = (searchRes as { payload?: unknown[] })?.payload ?? [];
        const ids = contacts.map(c => (c as { id: number }).id);
        const delRes = await pMap(ids, 5, (id) => deleteContact(http, id));
        results.push(`✅ Chatwoot: ${delRes.filter(Boolean).length}/${ids.length} contatos deletados`);
      } catch (e) {
        results.push(`⚠️ Chatwoot: falhou (${(e as Error)?.message ?? String(e)})`);
      }

      // 2. Redis (prefixo t:{tenantId}:)
      try {
        const instanceFilter = args.instance ? String(args.instance) : '*';
        const jidSuffix1 = `${phone}@s.whatsapp.net`;
        const jidSuffix2 = `${phone}@g.us`;
        let redisDeleted = 0;
        for (const prefix of ['sessao', 'human_takeover', 'debounce_ts', 'buffer']) {
          for (const suffix of [jidSuffix1, jidSuffix2, phone]) {
            redisDeleted += await deleteRedisKeysByPattern(`t:${tenantId}:${prefix}:${instanceFilter}:${suffix}`).catch(() => 0);
            // compatibilidade: chaves sem prefixo de tenant (instâncias antigas)
            redisDeleted += await deleteRedisKeysByPattern(`${prefix}:${instanceFilter}:${suffix}`).catch(() => 0);
          }
        }
        results.push(`✅ Redis: ${redisDeleted} chaves deletadas`);
      } catch (e) {
        results.push(`⚠️ Redis: falhou (${(e as Error)?.message ?? String(e)})`);
      }

      // 3. MongoDB
      try {
        const db = await getDb();
        const convDel = await db.collection('conversations').deleteMany({ phone, tenantId }).catch(() => ({ deletedCount: 0 }));
        const custDel = await db.collection('customers').deleteMany({ phone, tenantId }).catch(() => ({ deletedCount: 0 }));
        results.push(`✅ MongoDB: ${convDel.deletedCount} conversas, ${custDel.deletedCount} customers deletados`);
      } catch (e) {
        results.push(`⚠️ MongoDB: falhou (${(e as Error)?.message ?? String(e)})`);
      }

      // 4. Qdrant (coleção por agente)
      if (args.agentId) {
        const collection = `agent_${args.agentId}`;
        const qFilter = { must: [{ key: 'phone', match: { value: phone } }] };
        const qdrantRes = await deleteQdrantPoints(collection, qFilter);
        results.push(
          qdrantRes.error
            ? `⚠️ Qdrant: ${qdrantRes.error}`
            : `✅ Qdrant [${collection}]: ${qdrantRes.deleted} blocos apagados`
        );
      }

      return results.join('\n');
    }

    case 'system_clear_agent_conversations': {
      const agentId = String(args.agentId ?? '');
      const tenantId = String(args.tenantId ?? '');
      if (!agentId) return '❌ Parâmetro "agentId" obrigatório.';
      if (!tenantId) return '❌ Parâmetro "tenantId" obrigatório.';

      const summary: string[] = [];

      // 1. Chatwoot — contatos + conversas da inbox do agente
      try {
        const http = chatwootHttp();
        const inboxId = args.chatwootInboxId ? Number(args.chatwootInboxId) : undefined;

        const contactIds = await listAllChatwootContactIds(http);
        const contactsRes = await pMap(contactIds, 10, (id) => deleteContact(http, id));
        const contactsDeleted = contactsRes.filter(Boolean).length;

        const convIds = await listAllChatwootConversationIds(http, inboxId);
        const convsRes = await pMap(convIds, 10, (id) => deleteConversation(http, id));
        const convsDeleted = convsRes.filter(Boolean).length;

        summary.push(
          `✅ Chatwoot: ${contactsDeleted}/${contactIds.length} contatos, ` +
          `${convsDeleted}/${convIds.length} conversas deletadas`
        );
      } catch (e) {
        summary.push(`⚠️ Chatwoot: falhou (${(e as Error)?.message ?? String(e)})`);
      }

      // 2. Redis — chaves prefixadas por tenant
      try {
        let redisDeleted = 0;
        for (const prefix of ['sessao', 'human_takeover', 'debounce_ts', 'buffer']) {
          redisDeleted += await deleteRedisKeysByPattern(`t:${tenantId}:${prefix}:*`).catch(() => 0);
        }
        // buffer por conversationId (sem instância)
        redisDeleted += await deleteRedisKeysByPattern(`buffer:t:${tenantId}:*`).catch(() => 0);
        summary.push(`✅ Redis: ${redisDeleted} chaves deletadas`);
      } catch (e) {
        summary.push(`⚠️ Redis: falhou (${(e as Error)?.message ?? String(e)})`);
      }

      // 3. MongoDB — conversations + customers do agente (preserva config do agente e knowledge)
      try {
        const db = await getDb();
        const convDel = await db.collection('conversations').deleteMany({ agentId, tenantId }).catch(() => ({ deletedCount: 0 }));
        const custDel = await db.collection('customers').deleteMany({ agentId, tenantId }).catch(() => ({ deletedCount: 0 }));
        summary.push(
          `✅ MongoDB: ${convDel.deletedCount} conversas, ${custDel.deletedCount} customers deletados ` +
          `(config do agente e knowledge preservados)`
        );
      } catch (e) {
        summary.push(`⚠️ MongoDB: falhou (${(e as Error)?.message ?? String(e)})`);
      }

      // 4. Qdrant — coleção do agente
      const collection = `agent_${agentId}`;
      const qdrantRes = await deleteQdrantPoints(collection, null);
      summary.push(
        qdrantRes.error
          ? `⚠️ Qdrant: ${qdrantRes.error}`
          : `✅ Qdrant [${collection}]: ${qdrantRes.deleted} blocos de memória apagados`
      );

      return summary.join('\n');
    }

    default:
      return `❌ Ferramenta não encontrada: ${name}`;
  }
}
