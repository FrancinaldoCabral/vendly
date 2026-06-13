import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config.js';
import { createClient, safeRequest, toText } from '../utils/http.js';

const client = () =>
  createClient(`${config.coolify.url}/api/v1`, {
    Authorization: `Bearer ${config.coolify.token}`,
    'Content-Type': 'application/json',
  });

export const coolifyTools: Tool[] = [
  {
    name: 'coolify_list_projects',
    description: 'Lista todos os projetos do Coolify com seus ambientes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'coolify_list_servers',
    description: 'Lista os servidores conectados ao Coolify com status e recursos.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'coolify_list_services',
    description: 'Lista todos os serviços (aplicações) de um projeto/ambiente.',
    inputSchema: {
      type: 'object',
      properties: {
        project_uuid: { type: 'string', description: 'UUID do projeto (omitir para listar todos)' },
      },
    },
  },
  {
    name: 'coolify_get_service',
    description: 'Obtém detalhes de um serviço/aplicação específico.',
    inputSchema: {
      type: 'object',
      required: ['uuid'],
      properties: { uuid: { type: 'string', description: 'UUID do serviço' } },
    },
  },
  {
    name: 'coolify_deploy_service',
    description: 'Dispara um novo deploy de um serviço no Coolify.',
    inputSchema: {
      type: 'object',
      required: ['uuid'],
      properties: {
        uuid: { type: 'string', description: 'UUID do serviço/aplicação' },
        force: { type: 'boolean', description: 'Forçar rebuild sem cache (padrão false)' },
      },
    },
  },
  {
    name: 'coolify_restart_service',
    description: 'Reinicia um serviço em execução no Coolify.',
    inputSchema: {
      type: 'object',
      required: ['uuid'],
      properties: { uuid: { type: 'string', description: 'UUID do serviço' } },
    },
  },
  {
    name: 'coolify_stop_service',
    description: 'Para um serviço em execução no Coolify.',
    inputSchema: {
      type: 'object',
      required: ['uuid'],
      properties: { uuid: { type: 'string', description: 'UUID do serviço' } },
    },
  },
  {
    name: 'coolify_start_service',
    description: 'Inicia um serviço parado no Coolify.',
    inputSchema: {
      type: 'object',
      required: ['uuid'],
      properties: { uuid: { type: 'string', description: 'UUID do serviço' } },
    },
  },
  {
    name: 'coolify_list_envs',
    description: 'Lista as variáveis de ambiente de um serviço.',
    inputSchema: {
      type: 'object',
      required: ['uuid'],
      properties: { uuid: { type: 'string', description: 'UUID do serviço' } },
    },
  },
  {
    name: 'coolify_update_env',
    description: 'Cria ou atualiza uma variável de ambiente de um serviço. Requer novo deploy para ter efeito.',
    inputSchema: {
      type: 'object',
      required: ['uuid', 'key', 'value'],
      properties: {
        uuid: { type: 'string', description: 'UUID do serviço' },
        key: { type: 'string', description: 'Nome da variável de ambiente' },
        value: { type: 'string', description: 'Valor da variável' },
        is_preview: { type: 'boolean', description: 'Aplicar ao ambiente de preview (padrão false)' },
      },
    },
  },
  {
    name: 'coolify_update_envs_bulk',
    description: 'Atualiza múltiplas variáveis de ambiente de um serviço de uma vez.',
    inputSchema: {
      type: 'object',
      required: ['uuid', 'envs'],
      properties: {
        uuid: { type: 'string', description: 'UUID do serviço' },
        envs: {
          type: 'array',
          description: 'Array de variáveis de ambiente',
          items: {
            type: 'object',
            required: ['key', 'value'],
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
              is_preview: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
  {
    name: 'coolify_list_deployments',
    description: 'Lista o histórico de deployments de um serviço.',
    inputSchema: {
      type: 'object',
      required: ['uuid'],
      properties: { uuid: { type: 'string', description: 'UUID do serviço' } },
    },
  },
  {
    name: 'coolify_get_deployment_logs',
    description: 'Obtém os logs de um deployment específico.',
    inputSchema: {
      type: 'object',
      required: ['deployment_uuid'],
      properties: { deployment_uuid: { type: 'string', description: 'UUID do deployment' } },
    },
  },
  {
    name: 'coolify_list_databases',
    description: 'Lista todos os bancos de dados gerenciados pelo Coolify.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'coolify_get_database',
    description: 'Obtém detalhes de um banco de dados específico no Coolify.',
    inputSchema: {
      type: 'object',
      required: ['uuid'],
      properties: { uuid: { type: 'string', description: 'UUID do banco de dados' } },
    },
  },
  {
    name: 'coolify_server_resources',
    description: 'Obtém uso de CPU, memória e disco de um servidor gerenciado pelo Coolify.',
    inputSchema: {
      type: 'object',
      required: ['server_uuid'],
      properties: { server_uuid: { type: 'string', description: 'UUID do servidor' } },
    },
  },
];

type Args = Record<string, unknown>;

export async function handleCoolifyTool(name: string, args: Args): Promise<string> {
  const http = client();

  switch (name) {
    case 'coolify_list_projects': {
      const res = await safeRequest(() => http.get('/projects').then(r => r.data));
      return toText(res);
    }
    case 'coolify_list_servers': {
      const res = await safeRequest(() => http.get('/servers').then(r => r.data));
      return toText(res);
    }
    case 'coolify_list_services': {
      const url = args.project_uuid
        ? `/projects/${args.project_uuid}/services`
        : '/services';
      const res = await safeRequest(() => http.get(url).then(r => r.data));
      return toText(res);
    }
    case 'coolify_get_service': {
      const res = await safeRequest(() => http.get(`/services/${args.uuid}`).then(r => r.data));
      return toText(res);
    }
    case 'coolify_deploy_service': {
      const payload = args.force ? { force: true } : {};
      const res = await safeRequest(() =>
        http.post(`/applications/${args.uuid}/deploy`, payload).then(r => r.data)
      );
      return toText(res);
    }
    case 'coolify_restart_service': {
      const res = await safeRequest(() =>
        http.post(`/applications/${args.uuid}/restart`).then(r => r.data)
      );
      return toText(res);
    }
    case 'coolify_stop_service': {
      const res = await safeRequest(() =>
        http.post(`/applications/${args.uuid}/stop`).then(r => r.data)
      );
      return toText(res);
    }
    case 'coolify_start_service': {
      const res = await safeRequest(() =>
        http.post(`/applications/${args.uuid}/start`).then(r => r.data)
      );
      return toText(res);
    }
    case 'coolify_list_envs': {
      const res = await safeRequest(() =>
        http.get(`/applications/${args.uuid}/envs`).then(r => r.data)
      );
      return toText(res);
    }
    case 'coolify_update_env': {
      const payload = {
        key: args.key,
        value: args.value,
        is_preview: args.is_preview ?? false,
      };
      const res = await safeRequest(() =>
        http.post(`/applications/${args.uuid}/envs`, payload).then(r => r.data)
      );
      return toText(res);
    }
    case 'coolify_update_envs_bulk': {
      const res = await safeRequest(() =>
        http.patch(`/applications/${args.uuid}/envs/bulk`, { data: args.envs }).then(r => r.data)
      );
      return toText(res);
    }
    case 'coolify_list_deployments': {
      const res = await safeRequest(() =>
        http.get(`/applications/${args.uuid}/deployments`).then(r => r.data)
      );
      return toText(res);
    }
    case 'coolify_get_deployment_logs': {
      const res = await safeRequest(() =>
        http.get(`/deployments/${args.deployment_uuid}`).then(r => r.data)
      );
      return toText(res);
    }
    case 'coolify_list_databases': {
      const res = await safeRequest(() => http.get('/databases').then(r => r.data));
      return toText(res);
    }
    case 'coolify_get_database': {
      const res = await safeRequest(() => http.get(`/databases/${args.uuid}`).then(r => r.data));
      return toText(res);
    }
    case 'coolify_server_resources': {
      const res = await safeRequest(() =>
        http.get(`/servers/${args.server_uuid}/resources`).then(r => r.data)
      );
      return toText(res);
    }
    default:
      return `❌ Ferramenta desconhecida: ${name}`;
  }
}
