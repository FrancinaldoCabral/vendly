import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Redis } from 'ioredis';
import { config } from '../config.js';

let _redis: InstanceType<typeof Redis> | null = null;

export function getRedis(): InstanceType<typeof Redis> {
  if (_redis) return _redis;
  _redis = new Redis(config.redis.url, {
    lazyConnect: true,
    connectTimeout: 10_000,
    maxRetriesPerRequest: 2,
  });
  return _redis;
}

export const redisTools: Tool[] = [
  {
    name: 'redis_get',
    description: 'Obtém o valor de uma chave Redis.',
    inputSchema: {
      type: 'object',
      required: ['key'],
      properties: { key: { type: 'string' } },
    },
  },
  {
    name: 'redis_set',
    description: 'Define o valor de uma chave Redis com TTL opcional.',
    inputSchema: {
      type: 'object',
      required: ['key', 'value'],
      properties: {
        key: { type: 'string' },
        value: { type: 'string', description: 'Valor (objetos serão serializados em JSON)' },
        ttl: { type: 'number', description: 'TTL em segundos (opcional)' },
      },
    },
  },
  {
    name: 'redis_delete',
    description: 'Remove uma ou mais chaves do Redis.',
    inputSchema: {
      type: 'object',
      required: ['keys'],
      properties: {
        keys: {
          description: 'Chave ou lista de chaves',
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
      },
    },
  },
  {
    name: 'redis_list_keys',
    description: 'Lista chaves que correspondem a um padrão (use * como wildcard).',
    inputSchema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'Padrão de busca (ex: "session:*", "cache:*")' },
        count: { type: 'number', description: 'Número aproximado de chaves por scan (padrão 100)' },
      },
    },
  },
  {
    name: 'redis_hget',
    description: 'Obtém um ou todos os campos de um hash Redis.',
    inputSchema: {
      type: 'object',
      required: ['key'],
      properties: {
        key: { type: 'string' },
        field: { type: 'string', description: 'Campo específico (omitir para retornar todos os campos)' },
      },
    },
  },
  {
    name: 'redis_hset',
    description: 'Define campos em um hash Redis.',
    inputSchema: {
      type: 'object',
      required: ['key', 'fields'],
      properties: {
        key: { type: 'string' },
        fields: { type: 'object', description: 'Objeto com campo:valor' },
      },
    },
  },
  {
    name: 'redis_lpush',
    description: 'Insere valores no início de uma lista Redis.',
    inputSchema: {
      type: 'object',
      required: ['key', 'values'],
      properties: {
        key: { type: 'string' },
        values: { type: 'array', items: { type: 'string' }, description: 'Valores a inserir' },
      },
    },
  },
  {
    name: 'redis_lrange',
    description: 'Obtém elementos de uma lista Redis por índice.',
    inputSchema: {
      type: 'object',
      required: ['key'],
      properties: {
        key: { type: 'string' },
        start: { type: 'number', description: 'Índice inicial (padrão 0)' },
        stop: { type: 'number', description: 'Índice final (padrão -1 = todos)' },
      },
    },
  },
  {
    name: 'redis_ttl',
    description: 'Verifica o TTL restante de uma chave Redis.',
    inputSchema: {
      type: 'object',
      required: ['key'],
      properties: { key: { type: 'string' } },
    },
  },
  {
    name: 'redis_info',
    description: 'Retorna informações sobre o servidor Redis (memória, clientes, estatísticas).',
    inputSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['server', 'clients', 'memory', 'stats', 'keyspace', 'all'],
          description: 'Seção específica (padrão: all)',
        },
      },
    },
  },
  {
    name: 'redis_expire',
    description: 'Define ou atualiza o TTL de uma chave existente.',
    inputSchema: {
      type: 'object',
      required: ['key', 'seconds'],
      properties: {
        key: { type: 'string' },
        seconds: { type: 'number', description: 'TTL em segundos' },
      },
    },
  },
  {
    name: 'redis_incr',
    description: 'Incrementa o valor inteiro de uma chave (cria com 0 se não existir). Útil para contadores.',
    inputSchema: {
      type: 'object',
      required: ['key'],
      properties: {
        key: { type: 'string' },
        by: { type: 'number', description: 'Valor a incrementar (padrão 1)' },
      },
    },
  },
  {
    name: 'redis_rpush',
    description: 'Insere valores no final de uma lista Redis (append). Ideal para buffers de mensagens.',
    inputSchema: {
      type: 'object',
      required: ['key', 'values'],
      properties: {
        key: { type: 'string' },
        values: { type: 'array', items: { type: 'string' }, description: 'Valores a inserir no fim da lista' },
      },
    },
  },
  {
    name: 'redis_xadd',
    description: 'Adiciona uma entrada a um Redis Stream. Cria o stream se não existir.',
    inputSchema: {
      type: 'object',
      required: ['stream', 'fields'],
      properties: {
        stream: { type: 'string', description: 'Nome do stream (ex: events:biz_abc123)' },
        fields: { type: 'object', description: 'Campos da entrada (chave:valor)' },
        id: { type: 'string', description: 'ID da entrada (padrão: * para auto-gerado)' },
        maxlen: { type: 'number', description: 'Tamanho máximo do stream (MAXLEN ~)' },
      },
    },
  },
  {
    name: 'redis_xread',
    description: 'Lê entradas de um ou mais Redis Streams.',
    inputSchema: {
      type: 'object',
      required: ['streams'],
      properties: {
        streams: {
          type: 'array',
          description: 'Array de {key, id} onde id é o cursor (0 = desde o início, $ = apenas novos)',
          items: { type: 'object', properties: { key: { type: 'string' }, id: { type: 'string' } } },
        },
        count: { type: 'number', description: 'Máximo de entradas por stream (padrão 10)' },
      },
    },
  },
  {
    name: 'redis_xgroup_create',
    description: 'Cria um consumer group em um Redis Stream.',
    inputSchema: {
      type: 'object',
      required: ['stream', 'group'],
      properties: {
        stream: { type: 'string', description: 'Nome do stream' },
        group: { type: 'string', description: 'Nome do consumer group' },
        id: { type: 'string', description: 'ID de início: $ (apenas novos) ou 0 (todos). Padrão: $' },
        mkstream: { type: 'boolean', description: 'Criar o stream se não existir (padrão true)' },
      },
    },
  },
  {
    name: 'redis_xreadgroup',
    description: 'Lê entradas de um Redis Stream como membro de um consumer group.',
    inputSchema: {
      type: 'object',
      required: ['stream', 'group', 'consumer'],
      properties: {
        stream: { type: 'string' },
        group: { type: 'string' },
        consumer: { type: 'string', description: 'Nome do consumer (ex: worker_1)' },
        count: { type: 'number', description: 'Máximo de entradas (padrão 10)' },
        noack: { type: 'boolean', description: 'Não exigir ACK (padrão false)' },
      },
    },
  },
  {
    name: 'redis_xack',
    description: 'Confirma o processamento de entradas de um Redis Stream (consumer group).',
    inputSchema: {
      type: 'object',
      required: ['stream', 'group', 'ids'],
      properties: {
        stream: { type: 'string' },
        group: { type: 'string' },
        ids: { type: 'array', items: { type: 'string' }, description: 'IDs das entradas a confirmar' },
      },
    },
  },
];

type Args = Record<string, unknown>;

async function safeExec<T>(fn: (r: InstanceType<typeof Redis>) => Promise<T>): Promise<string> {
  try {
    const r = getRedis();
    const result = await fn(r);
    return JSON.stringify(result, null, 2);
  } catch (err) {
    return `❌ Erro Redis: ${String(err)}`;
  }
}

export async function handleRedisTool(name: string, args: Args): Promise<string> {
  switch (name) {
    case 'redis_get': {
      return safeExec(async r => {
        const val = await r.get(args.key as string);
        if (!val) return null;
        try { return JSON.parse(val); } catch { return val; }
      });
    }
    case 'redis_set': {
      return safeExec(async r => {
        const value = typeof args.value === 'string' ? args.value : JSON.stringify(args.value);
        if (args.ttl) {
          return r.set(args.key as string, value, 'EX', args.ttl as number);
        }
        return r.set(args.key as string, value);
      });
    }
    case 'redis_delete': {
      return safeExec(async r => {
        const keys = Array.isArray(args.keys) ? args.keys as string[] : [args.keys as string];
        const count = await r.del(...keys);
        return { deleted: count };
      });
    }
    case 'redis_list_keys': {
      return safeExec(async r => {
        const keys: string[] = [];
        const stream = r.scanStream({ match: args.pattern as string, count: (args.count as number) ?? 100 });
        for await (const batch of stream) keys.push(...(batch as string[]));
        return { keys, total: keys.length };
      });
    }
    case 'redis_hget': {
      return safeExec(async r => {
        if (args.field) return r.hget(args.key as string, args.field as string);
        return r.hgetall(args.key as string);
      });
    }
    case 'redis_hset': {
      return safeExec(async r => {
        const fields = args.fields as Record<string, string>;
        const flat: string[] = [];
        for (const [k, v] of Object.entries(fields)) flat.push(k, String(v));
        const count = await r.hset(args.key as string, ...flat);
        return { updated: count };
      });
    }
    case 'redis_lpush': {
      return safeExec(async r => {
        const values = args.values as string[];
        const len = await r.lpush(args.key as string, ...values);
        return { length: len };
      });
    }
    case 'redis_lrange': {
      return safeExec(async r =>
        r.lrange(args.key as string, (args.start as number) ?? 0, (args.stop as number) ?? -1)
      );
    }
    case 'redis_ttl': {
      return safeExec(async r => {
        const ttl = await r.ttl(args.key as string);
        return { key: args.key, ttl_seconds: ttl, expires: ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : null };
      });
    }
    case 'redis_info': {
      return safeExec(async r => {
        const section = (args.section as string) ?? 'all';
        return section === 'all' ? r.info() : r.info(section);
      });
    }
    case 'redis_expire': {
      return safeExec(async r => {
        const result = await r.expire(args.key as string, args.seconds as number);
        return { success: result === 1 };
      });
    }
    case 'redis_incr': {
      return safeExec(async r => {
        const by = (args.by as number) ?? 1;
        const val = by === 1
          ? await r.incr(args.key as string)
          : await r.incrby(args.key as string, by);
        return { value: val };
      });
    }
    case 'redis_rpush': {
      return safeExec(async r => {
        const values = args.values as string[];
        const len = await r.rpush(args.key as string, ...values);
        return { length: len };
      });
    }
    case 'redis_xadd': {
      return safeExec(async r => {
        const id = (args.id as string) ?? '*';
        const fields = args.fields as Record<string, unknown>;
        const flat: string[] = [];
        for (const [k, v] of Object.entries(fields)) flat.push(k, String(v));
        const cmd = r.pipeline();
        if (args.maxlen) {
          cmd.xadd(args.stream as string, 'MAXLEN', '~', String(args.maxlen as number), id, ...flat);
        } else {
          cmd.xadd(args.stream as string, id, ...flat);
        }
        const res = await cmd.exec();
        return { id: res?.[0]?.[1] };
      });
    }
    case 'redis_xread': {
      return safeExec(async r => {
        const streams = args.streams as Array<{ key: string; id: string }>;
        const keys = streams.map(s => s.key);
        const ids = streams.map(s => s.id ?? '0');
        const count = (args.count as number) ?? 10;
        const res = await (r as any).xread('COUNT', count, 'STREAMS', ...keys, ...ids);
        if (!res) return [];
        return res.map(([stream, entries]: [string, [string, string[]][]]) => ({
          stream,
          entries: entries.map(([id, fields]) => {
            const obj: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
            return { id, fields: obj };
          }),
        }));
      });
    }
    case 'redis_xgroup_create': {
      return safeExec(async r => {
        const id = (args.id as string) ?? '$';
        const mkstream = (args.mkstream as boolean) !== false;
        const cmdArgs: string[] = [args.stream as string, args.group as string, id];
        if (mkstream) cmdArgs.push('MKSTREAM');
        try {
          await (r as any).xgroup('CREATE', ...cmdArgs);
          return { created: true };
        } catch (e: any) {
          if (e?.message?.includes('BUSYGROUP')) return { created: false, note: 'Consumer group já existe' };
          throw e;
        }
      });
    }
    case 'redis_xreadgroup': {
      return safeExec(async r => {
        const count = (args.count as number) ?? 10;
        const noack = args.noack ? ['NOACK'] : [];
        const res = await (r as any).xreadgroup(
          'GROUP', args.group as string, args.consumer as string,
          'COUNT', count,
          ...noack,
          'STREAMS', args.stream as string, '>'
        );
        if (!res) return [];
        return res.map(([stream, entries]: [string, [string, string[]][]]): object => ({
          stream,
          entries: entries.map(([id, fields]: [string, string[]]) => {
            const obj: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
            return { id, fields: obj };
          }),
        }));
      });
    }
    case 'redis_xack': {
      return safeExec(async r => {
        const ids = args.ids as string[];
        const count = await (r as any).xack(args.stream as string, args.group as string, ...ids);
        return { acknowledged: count };
      });
    }
    default:
      return `❌ Ferramenta desconhecida: ${name}`;
  }
}

export async function closeRedis(): Promise<void> {
  if (_redis) {
    _redis.quit();
    _redis = null;
  }
}
