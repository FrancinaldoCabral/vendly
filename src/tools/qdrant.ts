import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config.js';
import { createClient, safeRequest, toText } from '../utils/http.js';

const client = () => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.qdrant.apiKey) headers['api-key'] = config.qdrant.apiKey;
  return createClient(config.qdrant.url, headers);
};

export const qdrantTools: Tool[] = [
  {
    name: 'qdrant_list_collections',
    description: 'Lista todas as collections (índices vetoriais) do Qdrant.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'qdrant_collection_info',
    description: 'Obtém detalhes de uma collection: dimensões, distância, quantidade de vetores.',
    inputSchema: {
      type: 'object',
      required: ['collection'],
      properties: { collection: { type: 'string' } },
    },
  },
  {
    name: 'qdrant_create_collection',
    description: 'Cria uma nova collection vetorial no Qdrant.',
    inputSchema: {
      type: 'object',
      required: ['collection', 'size', 'distance'],
      properties: {
        collection: { type: 'string', description: 'Nome da collection' },
        size: { type: 'number', description: 'Dimensão dos vetores (ex: 1536 para OpenAI, 768 para HuggingFace)' },
        distance: {
          type: 'string',
          enum: ['Cosine', 'Euclid', 'Dot', 'Manhattan'],
          description: 'Métrica de distância',
        },
        on_disk_payload: { type: 'boolean', description: 'Armazenar payload em disco (padrão false)' },
      },
    },
  },
  {
    name: 'qdrant_delete_collection',
    description: 'Remove permanentemente uma collection e todos os seus vetores.',
    inputSchema: {
      type: 'object',
      required: ['collection'],
      properties: { collection: { type: 'string' } },
    },
  },
  {
    name: 'qdrant_upsert_points',
    description: 'Insere ou atualiza pontos (vetores com payload) em uma collection.',
    inputSchema: {
      type: 'object',
      required: ['collection', 'points'],
      properties: {
        collection: { type: 'string' },
        points: {
          type: 'array',
          description: 'Array de pontos com {id, vector, payload}',
          items: {
            type: 'object',
            properties: {
              id: { description: 'ID do ponto (número ou UUID)' },
              vector: { type: 'array', items: { type: 'number' }, description: 'Vetor de embeddings' },
              payload: { type: 'object', description: 'Metadados do ponto' },
            },
          },
        },
      },
    },
  },
  {
    name: 'qdrant_search',
    description: 'Busca vetores similares em uma collection usando similarity search.',
    inputSchema: {
      type: 'object',
      required: ['collection', 'vector'],
      properties: {
        collection: { type: 'string' },
        vector: { type: 'array', items: { type: 'number' }, description: 'Vetor de query' },
        limit: { type: 'number', description: 'Número máximo de resultados (padrão 10)' },
        filter: { type: 'object', description: 'Filtro por payload (ex: {"must": [{"key": "category", "match": {"value": "tech"}}]})' },
        with_payload: { type: 'boolean', description: 'Incluir payload nos resultados (padrão true)' },
        score_threshold: { type: 'number', description: 'Score mínimo de similaridade (0-1)' },
      },
    },
  },
  {
    name: 'qdrant_get_points',
    description: 'Obtém pontos específicos por ID.',
    inputSchema: {
      type: 'object',
      required: ['collection', 'ids'],
      properties: {
        collection: { type: 'string' },
        ids: {
          type: 'array',
          description: 'Lista de IDs dos pontos',
          items: { description: 'ID numérico ou UUID' },
        },
        with_payload: { type: 'boolean', description: 'Incluir payload (padrão true)' },
        with_vector: { type: 'boolean', description: 'Incluir vetores (padrão false)' },
      },
    },
  },
  {
    name: 'qdrant_delete_points',
    description: 'Remove pontos de uma collection por ID ou filtro.',
    inputSchema: {
      type: 'object',
      required: ['collection'],
      properties: {
        collection: { type: 'string' },
        ids: { type: 'array', items: { type: 'object' }, description: 'IDs dos pontos a remover' },
        filter: { type: 'object', description: 'Filtro para remoção em lote' },
      },
    },
  },
  {
    name: 'qdrant_create_payload_index',
    description: 'Cria um índice em um campo do payload para filtros mais eficientes.',
    inputSchema: {
      type: 'object',
      required: ['collection', 'field_name', 'field_schema'],
      properties: {
        collection: { type: 'string' },
        field_name: { type: 'string', description: 'Nome do campo no payload' },
        field_schema: {
          type: 'string',
          enum: ['keyword', 'integer', 'float', 'bool', 'geo', 'text'],
          description: 'Tipo do campo',
        },
      },
    },
  },
];

type Args = Record<string, unknown>;

export async function handleQdrantTool(name: string, args: Args): Promise<string> {
  const http = client();

  switch (name) {
    case 'qdrant_list_collections': {
      const res = await safeRequest(() => http.get('/collections').then(r => r.data));
      return toText(res);
    }
    case 'qdrant_collection_info': {
      const res = await safeRequest(() =>
        http.get(`/collections/${args.collection}`).then(r => r.data)
      );
      return toText(res);
    }
    case 'qdrant_create_collection': {
      const payload = {
        vectors: {
          size: args.size,
          distance: args.distance,
        },
        on_disk_payload: args.on_disk_payload ?? false,
      };
      const res = await safeRequest(() =>
        http.put(`/collections/${args.collection}`, payload).then(r => r.data)
      );
      return toText(res);
    }
    case 'qdrant_delete_collection': {
      const res = await safeRequest(() =>
        http.delete(`/collections/${args.collection}`).then(r => r.data)
      );
      return toText(res);
    }
    case 'qdrant_upsert_points': {
      const payload = { points: args.points };
      const res = await safeRequest(() =>
        http.put(`/collections/${args.collection}/points`, payload).then(r => r.data)
      );
      return toText(res);
    }
    case 'qdrant_search': {
      const payload: Record<string, unknown> = {
        vector: args.vector,
        limit: args.limit ?? 10,
        with_payload: args.with_payload ?? true,
      };
      if (args.filter) payload.filter = args.filter;
      if (args.score_threshold) payload.score_threshold = args.score_threshold;
      const res = await safeRequest(() =>
        http.post(`/collections/${args.collection}/points/search`, payload).then(r => r.data)
      );
      return toText(res);
    }
    case 'qdrant_get_points': {
      const payload = {
        ids: args.ids,
        with_payload: args.with_payload ?? true,
        with_vector: args.with_vector ?? false,
      };
      const res = await safeRequest(() =>
        http.post(`/collections/${args.collection}/points`, payload).then(r => r.data)
      );
      return toText(res);
    }
    case 'qdrant_delete_points': {
      const selector: Record<string, unknown> = {};
      if (args.ids) selector.points = args.ids;
      else if (args.filter) selector.filter = args.filter;
      const res = await safeRequest(() =>
        http.post(`/collections/${args.collection}/points/delete`, selector).then(r => r.data)
      );
      return toText(res);
    }
    case 'qdrant_create_payload_index': {
      const payload = { field_name: args.field_name, field_schema: args.field_schema };
      const res = await safeRequest(() =>
        http.put(`/collections/${args.collection}/index`, payload).then(r => r.data)
      );
      return toText(res);
    }
    default:
      return `❌ Ferramenta desconhecida: ${name}`;
  }
}
