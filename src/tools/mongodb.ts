import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { MongoClient, type Db } from 'mongodb';
import { config } from '../config.js';

let _client: MongoClient | null = null;

export async function getClient(): Promise<MongoClient> {
  if (_client) return _client;
  _client = new MongoClient(config.mongodb.uri, { connectTimeoutMS: 10_000, serverSelectionTimeoutMS: 10_000 });
  await _client.connect();
  return _client;
}

export function getDb(dbName = 'vendly'): Promise<Db> {
  return getClient().then(c => c.db(dbName));
}

function db(dbName: string): Promise<Db> {
  return getDb(dbName);
}

export const mongodbTools: Tool[] = [
  {
    name: 'mongo_list_databases',
    description: 'Lista todos os databases disponíveis no MongoDB com tamanho em MB.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mongo_list_collections',
    description: 'Lista todas as collections de um database.',
    inputSchema: {
      type: 'object',
      required: ['database'],
      properties: { database: { type: 'string', description: 'Nome do database' } },
    },
  },
  {
    name: 'mongo_find',
    description: 'Busca documentos em uma collection com filtro, projeção e paginação.',
    inputSchema: {
      type: 'object',
      required: ['database', 'collection'],
      properties: {
        database: { type: 'string', description: 'Nome do database' },
        collection: { type: 'string' },
        filter: { type: 'object', description: 'Filtro MongoDB (ex: {"status": "active"})' },
        projection: { type: 'object', description: 'Campos a retornar' },
        sort: { type: 'object', description: 'Ordenação (ex: {"createdAt": -1})' },
        limit: { type: 'number', description: 'Máximo de documentos (padrão 20)' },
        skip: { type: 'number', description: 'Pular N documentos' },
      },
    },
  },
  {
    name: 'mongo_count',
    description: 'Conta documentos em uma collection com filtro opcional.',
    inputSchema: {
      type: 'object',
      required: ['database', 'collection'],
      properties: {
        database: { type: 'string', description: 'Nome do database' },
        collection: { type: 'string' },
        filter: { type: 'object' },
      },
    },
  },
  {
    name: 'mongo_insert',
    description: 'Insere um ou mais documentos em uma collection.',
    inputSchema: {
      type: 'object',
      required: ['database', 'collection', 'documents'],
      properties: {
        database: { type: 'string', description: 'Nome do database' },
        collection: { type: 'string' },
        documents: {
          description: 'Documento único ou array de documentos',
          oneOf: [{ type: 'object' }, { type: 'array', items: { type: 'object' } }],
        },
      },
    },
  },
  {
    name: 'mongo_update',
    description: 'Atualiza documentos em uma collection.',
    inputSchema: {
      type: 'object',
      required: ['database', 'collection', 'filter', 'update'],
      properties: {
        database: { type: 'string', description: 'Nome do database' },
        collection: { type: 'string' },
        filter: { type: 'object', description: 'Critério de seleção' },
        update: { type: 'object', description: 'Operação de update (ex: {"$set": {"status": "done"}})' },
        upsert: { type: 'boolean', description: 'Criar se não existir (padrão false)' },
        many: { type: 'boolean', description: 'Atualizar múltiplos documentos (padrão false)' },
      },
    },
  },
  {
    name: 'mongo_delete',
    description: 'Remove documentos de uma collection.',
    inputSchema: {
      type: 'object',
      required: ['database', 'collection', 'filter'],
      properties: {
        database: { type: 'string', description: 'Nome do database' },
        collection: { type: 'string' },
        filter: { type: 'object', description: 'Critério de seleção dos documentos a remover' },
        many: { type: 'boolean', description: 'Remover múltiplos documentos (padrão false)' },
      },
    },
  },
  {
    name: 'mongo_aggregate',
    description: 'Executa um pipeline de agregação MongoDB.',
    inputSchema: {
      type: 'object',
      required: ['database', 'collection', 'pipeline'],
      properties: {
        database: { type: 'string', description: 'Nome do database' },
        collection: { type: 'string' },
        pipeline: {
          type: 'array',
          items: { type: 'object' },
          description: 'Pipeline de agregação (ex: [{"$match": {}}, {"$group": {...}}])',
        },
      },
    },
  },
  {
    name: 'mongo_create_collection',
    description: 'Cria uma nova collection em um database.',
    inputSchema: {
      type: 'object',
      required: ['database', 'collection'],
      properties: {
        database: { type: 'string', description: 'Nome do database' },
        collection: { type: 'string' },
        validator: { type: 'object', description: 'Schema de validação JSON opcional' },
      },
    },
  },
  {
    name: 'mongo_drop_collection',
    description: 'Remove permanentemente uma collection e todos os seus documentos.',
    inputSchema: {
      type: 'object',
      required: ['database', 'collection'],
      properties: {
        database: { type: 'string', description: 'Nome do database' },
        collection: { type: 'string' },
      },
    },
  },
  {
    name: 'mongo_drop_database',
    description: 'Remove permanentemente um database inteiro e todas as suas collections.',
    inputSchema: {
      type: 'object',
      required: ['database'],
      properties: {
        database: { type: 'string', description: 'Nome do database a remover' },
      },
    },
  },
  {
    name: 'mongo_create_index',
    description: 'Cria um índice em uma collection.',
    inputSchema: {
      type: 'object',
      required: ['database', 'collection', 'keys'],
      properties: {
        database: { type: 'string', description: 'Nome do database' },
        collection: { type: 'string' },
        keys: { type: 'object', description: 'Campos e direção do índice (ex: {"email": 1})' },
        unique: { type: 'boolean', description: 'Índice único (padrão false)' },
        name: { type: 'string', description: 'Nome do índice' },
      },
    },
  },
];

type Args = Record<string, unknown>;

async function safeExec<T>(fn: () => Promise<T>): Promise<string> {
  try {
    const result = await fn();
    return JSON.stringify(result, null, 2);
  } catch (err) {
    return `❌ Erro MongoDB: ${String(err)}`;
  }
}

export async function handleMongodbTool(name: string, args: Args): Promise<string> {
  switch (name) {
    case 'mongo_list_databases': {
      return safeExec(async () => {
        const c = await getClient();
        const admin = c.db().admin();
        return admin.listDatabases();
      });
    }
    case 'mongo_list_collections': {
      return safeExec(async () => {
        const database = await db(args.database as string);
        return database.listCollections().toArray();
      });
    }
    case 'mongo_find': {
      return safeExec(async () => {
        const database = await db(args.database as string);
        const col = database.collection(args.collection as string);
        const filter = (args.filter as Record<string, unknown>) ?? {};
        let cursor = col.find(filter);
        if (args.projection) cursor = cursor.project(args.projection as Record<string, unknown>);
        if (args.sort) cursor = cursor.sort(args.sort as Parameters<typeof cursor.sort>[0]);
        if (args.skip) cursor = cursor.skip(args.skip as number);
        cursor = cursor.limit((args.limit as number) ?? 20);
        return cursor.toArray();
      });
    }
    case 'mongo_count': {
      return safeExec(async () => {
        const database = await db(args.database as string);
        const col = database.collection(args.collection as string);
        const count = await col.countDocuments((args.filter as Record<string, unknown>) ?? {});
        return { count };
      });
    }
    case 'mongo_insert': {
      return safeExec(async () => {
        const database = await db(args.database as string);
        const col = database.collection(args.collection as string);
        const docs = args.documents;
        if (Array.isArray(docs)) {
          return col.insertMany(docs as Record<string, unknown>[]);
        }
        return col.insertOne(docs as Record<string, unknown>);
      });
    }
    case 'mongo_update': {
      return safeExec(async () => {
        const database = await db(args.database as string);
        const col = database.collection(args.collection as string);
        const filter = args.filter as Record<string, unknown>;
        const update = args.update as Record<string, unknown>;
        const options = { upsert: (args.upsert as boolean) ?? false };
        if (args.many) return col.updateMany(filter, update, options);
        return col.updateOne(filter, update, options);
      });
    }
    case 'mongo_delete': {
      return safeExec(async () => {
        const database = await db(args.database as string);
        const col = database.collection(args.collection as string);
        const filter = args.filter as Record<string, unknown>;
        if (args.many) return col.deleteMany(filter);
        return col.deleteOne(filter);
      });
    }
    case 'mongo_aggregate': {
      return safeExec(async () => {
        const database = await db(args.database as string);
        const col = database.collection(args.collection as string);
        return col.aggregate(args.pipeline as Record<string, unknown>[]).toArray();
      });
    }
    case 'mongo_create_collection': {
      return safeExec(async () => {
        const database = await db(args.database as string);
        const options: Record<string, unknown> = {};
        if (args.validator) options.validator = args.validator;
        await database.createCollection(args.collection as string, options);
        return { created: args.collection };
      });
    }
    case 'mongo_drop_collection': {
      return safeExec(async () => {
        const database = await db(args.database as string);
        const result = await database.dropCollection(args.collection as string);
        return { dropped: result };
      });
    }
    case 'mongo_drop_database': {
      return safeExec(async () => {
        const database = await db(args.database as string);
        const result = await database.dropDatabase();
        return { dropped: result, database: args.database };
      });
    }
    case 'mongo_create_index': {
      return safeExec(async () => {
        const database = await db(args.database as string);
        const col = database.collection(args.collection as string);
        const indexName = await col.createIndex(args.keys as Parameters<typeof col.createIndex>[0], {
          unique: (args.unique as boolean) ?? false,
          name: args.name as string | undefined,
        });
        return { indexName };
      });
    }
    default:
      return `❌ Ferramenta desconhecida: ${name}`;
  }
}

export async function closeMongo(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
  }
}
