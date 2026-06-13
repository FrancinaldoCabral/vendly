import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config.js';
import { createClient, safeRequest, toText } from '../utils/http.js';

const client = () =>
  createClient(`${config.n8n.url}/api/v1`, {
    'X-N8N-API-KEY': config.n8n.apiKey,
    'Content-Type': 'application/json',
  });

export const n8nTools: Tool[] = [
  {
    name: 'n8n_list_workflows',
    description: 'Lista todos os workflows do n8n com status e metadados.',
    inputSchema: {
      type: 'object',
      properties: {
        active: { type: 'boolean', description: 'Filtrar por workflows ativos (true) ou inativos (false)' },
        limit: { type: 'number', description: 'Quantidade máxima de resultados (padrão 100)' },
      },
    },
  },
  {
    name: 'n8n_get_workflow',
    description: 'Obtém detalhes completos de um workflow pelo ID, incluindo todos os nós e conexões.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', description: 'ID do workflow' } },
    },
  },
  {
    name: 'n8n_create_workflow',
    description: 'Cria um novo workflow no n8n.',
    inputSchema: {
      type: 'object',
      required: ['name', 'nodes', 'connections'],
      properties: {
        name: { type: 'string', description: 'Nome do workflow' },
        nodes: { type: 'array', items: { type: 'object' }, description: 'Array de nós do workflow' },
        connections: { type: 'object', description: 'Objeto de conexões entre nós' },
        active: { type: 'boolean', description: 'Ativar imediatamente (padrão false)' },
        settings: { type: 'object', description: 'Configurações do workflow' },
      },
    },
  },
  {
    name: 'n8n_update_workflow',
    description: 'Atualiza um workflow existente (nós, conexões, nome, configurações).',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'ID do workflow' },
        name: { type: 'string' },
        nodes: { type: 'array', items: { type: 'object' } },
        connections: { type: 'object' },
        settings: { type: 'object' },
      },
    },
  },
  {
    name: 'n8n_activate_workflow',
    description: 'Ativa ou desativa um workflow.',
    inputSchema: {
      type: 'object',
      required: ['id', 'active'],
      properties: {
        id: { type: 'string', description: 'ID do workflow' },
        active: { type: 'boolean', description: 'true para ativar, false para desativar' },
      },
    },
  },
  {
    name: 'n8n_delete_workflow',
    description: 'Remove permanentemente um workflow.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
  },
  {
    name: 'n8n_list_executions',
    description: 'Lista execuções de workflows com status e timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Filtrar por workflow ID' },
        status: { type: 'string', enum: ['success', 'error', 'waiting', 'running'] },
        limit: { type: 'number', description: 'Limite de resultados (padrão 20)' },
      },
    },
  },
  {
    name: 'n8n_get_execution',
    description: 'Obtém detalhes completos de uma execução específica.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
  },
  {
    name: 'n8n_list_credentials',
    description: 'Lista as credenciais configuradas no n8n (sem expor valores sensíveis).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'n8n_create_credential',
    description:
      'Cria uma credencial no n8n. Tipos comuns: redis (host/port/password/database), mongoDb (connectionString), httpHeaderAuth (name/value), openAiApi (apiKey+baseUrl para OpenRouter), httpBasicAuth (user/password).',
    inputSchema: {
      type: 'object',
      required: ['name', 'type', 'data'],
      properties: {
        name: { type: 'string', description: 'Nome amigável da credencial' },
        type: { type: 'string', description: 'Tipo da credencial no n8n (redis, mongoDb, httpHeaderAuth, openAiApi...)' },
        data: { type: 'object', description: 'Campos da credencial conforme o tipo escolhido' },
      },
    },
  },
  {
    name: 'n8n_delete_credential',
    description: 'Remove permanentemente uma credencial do n8n pelo ID.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', description: 'ID da credencial' } },
    },
  },
];

type Args = Record<string, unknown>;

export async function handleN8nTool(name: string, args: Args): Promise<string> {
  const http = client();

  switch (name) {
    case 'n8n_list_workflows': {
      const params: Record<string, unknown> = { limit: args.limit ?? 100 };
      if (args.active !== undefined) params.active = args.active;
      const res = await safeRequest(() => http.get('/workflows', { params }).then(r => r.data));
      return toText(res);
    }
    case 'n8n_get_workflow': {
      const res = await safeRequest(() => http.get(`/workflows/${args.id}`).then(r => r.data));
      return toText(res);
    }
    case 'n8n_create_workflow': {
      const payload = {
        name: args.name,
        nodes: args.nodes,
        connections: args.connections,
        settings: args.settings ?? {},
      };
      const res = await safeRequest(() => http.post('/workflows', payload).then(r => r.data));
      return toText(res);
    }
    case 'n8n_update_workflow': {
      const { id, ...body } = args;
      const res = await safeRequest(() => http.put(`/workflows/${id}`, body).then(r => r.data));
      return toText(res);
    }
    case 'n8n_activate_workflow': {
      const endpoint = args.active ? 'activate' : 'deactivate';
      const res = await safeRequest(() =>
        http.post(`/workflows/${args.id}/${endpoint}`).then(r => r.data)
      );
      return toText(res);
    }
    case 'n8n_delete_workflow': {
      const res = await safeRequest(() => http.delete(`/workflows/${args.id}`).then(r => r.data));
      return toText(res);
    }
    case 'n8n_list_executions': {
      const params: Record<string, unknown> = { limit: args.limit ?? 20 };
      if (args.workflowId) params.workflowId = args.workflowId;
      if (args.status) params.status = args.status;
      const res = await safeRequest(() => http.get('/executions', { params }).then(r => r.data));
      return toText(res);
    }
    case 'n8n_get_execution': {
      const res = await safeRequest(() => http.get(`/executions/${args.id}`).then(r => r.data));
      return toText(res);
    }
    case 'n8n_list_credentials': {
      const res = await safeRequest(() => http.get('/credentials').then(r => r.data));
      return toText(res);
    }
    case 'n8n_create_credential': {
      const payload = { name: args.name, type: args.type, data: args.data };
      const res = await safeRequest(() => http.post('/credentials', payload).then(r => r.data));
      return toText(res);
    }
    case 'n8n_delete_credential': {
      const res = await safeRequest(() => http.delete(`/credentials/${args.id}`).then(r => r.data));
      return toText(res);
    }
    default:
      return `❌ Ferramenta desconhecida: ${name}`;
  }
}
