import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config.js';
import { createClient, safeRequest, toText } from '../utils/http.js';

const client = () =>
  createClient(config.chatwoot.url, {
    api_access_token: config.chatwoot.apiKey,
    'Content-Type': 'application/json',
  });

type Args = Record<string, unknown>;

function acct(args: Args): string {
  const id = (args.account_id as string | number | undefined) ?? config.chatwoot.accountId;
  return `/api/v1/accounts/${id}`;
}

const accountIdProp = {
  account_id: {
    type: 'string' as const,
    description: 'ID da conta Chatwoot (omitir para usar CHATWOOT_ACCOUNT_ID do env)',
  },
};

export const chatwootTools: Tool[] = [
  {
    name: 'chatwoot_list_accounts',
    description: 'Lista todas as contas do Chatwoot.',
    inputSchema: { type: 'object', properties: { page: { type: 'number' } } },
  },
  {
    name: 'chatwoot_create_account',
    description: 'Cria uma nova conta no Chatwoot.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    },
  },
  {
    name: 'chatwoot_list_conversations',
    description: 'Lista conversas do Chatwoot com filtros.',
    inputSchema: {
      type: 'object',
      properties: {
        ...accountIdProp,
        status: { type: 'string', enum: ['open', 'resolved', 'pending', 'snoozed', 'all'] },
        inbox_id: { type: 'number' },
        assignee_type: { type: 'string', enum: ['me', 'unassigned', 'all'] },
        page: { type: 'number' },
      },
    },
  },
  {
    name: 'chatwoot_get_conversation',
    description: 'Obtém detalhes completos de uma conversa.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { ...accountIdProp, id: { type: 'number' } },
    },
  },
  {
    name: 'chatwoot_send_message',
    description: 'Envia uma mensagem em uma conversa existente.',
    inputSchema: {
      type: 'object',
      required: ['conversation_id', 'content'],
      properties: {
        ...accountIdProp,
        conversation_id: { type: 'number' },
        content: { type: 'string' },
        message_type: { type: 'string', enum: ['outgoing', 'note'] },
        private: { type: 'boolean' },
      },
    },
  },
  {
    name: 'chatwoot_assign_conversation',
    description: 'Atribui uma conversa a um agente ou equipe (escalada humana).',
    inputSchema: {
      type: 'object',
      required: ['conversation_id'],
      properties: {
        ...accountIdProp,
        conversation_id: { type: 'number' },
        assignee_id: { type: 'number' },
        team_id: { type: 'number' },
      },
    },
  },
  {
    name: 'chatwoot_update_conversation_status',
    description: 'Atualiza o status de uma conversa.',
    inputSchema: {
      type: 'object',
      required: ['conversation_id', 'status'],
      properties: {
        ...accountIdProp,
        conversation_id: { type: 'number' },
        status: { type: 'string', enum: ['open', 'resolved', 'pending', 'snoozed'] },
      },
    },
  },
  {
    name: 'chatwoot_list_contacts',
    description: 'Lista contatos do Chatwoot com busca.',
    inputSchema: {
      type: 'object',
      properties: {
        ...accountIdProp,
        q: { type: 'string' },
        page: { type: 'number' },
      },
    },
  },
  {
    name: 'chatwoot_create_contact',
    description: 'Cria um novo contato no Chatwoot.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        ...accountIdProp,
        name: { type: 'string' },
        email: { type: 'string' },
        phone_number: { type: 'string' },
        identifier: { type: 'string' },
        additional_attributes: { type: 'object' },
      },
    },
  },
  {
    name: 'chatwoot_list_inboxes',
    description: 'Lista todas as inboxes configuradas no Chatwoot.',
    inputSchema: { type: 'object', properties: { ...accountIdProp } },
  },
  {
    name: 'chatwoot_list_agents',
    description: 'Lista todos os agentes da conta Chatwoot.',
    inputSchema: { type: 'object', properties: { ...accountIdProp } },
  },
  {
    name: 'chatwoot_get_reports',
    description: 'Obtém relatórios de atendimento.',
    inputSchema: {
      type: 'object',
      required: ['metric', 'type'],
      properties: {
        ...accountIdProp,
        metric: { type: 'string' },
        type: { type: 'string', enum: ['account', 'inbox', 'agent', 'team'] },
        id: { type: 'number' },
        since: { type: 'string' },
        until: { type: 'string' },
      },
    },
  },
];

export async function handleChatwootTool(name: string, args: Args): Promise<string> {
  const http = client();

  switch (name) {
    case 'chatwoot_list_accounts': {
      const params: Record<string, unknown> = {};
      if (args.page) params.page = args.page;
      const res = await safeRequest(() => http.get('/api/v1/accounts', { params }).then(r => r.data));
      return toText(res);
    }
    case 'chatwoot_create_account': {
      const res = await safeRequest(() =>
        http.post('/api/v1/accounts', { name: args.name }).then(r => r.data)
      );
      return toText(res);
    }
    case 'chatwoot_list_conversations': {
      const base = acct(args);
      const params: Record<string, unknown> = { page: args.page ?? 1 };
      if (args.status) params.status = args.status;
      if (args.inbox_id) params.inbox_id = args.inbox_id;
      if (args.assignee_type) params.assignee_type = args.assignee_type;
      const res = await safeRequest(() => http.get(`${base}/conversations`, { params }).then(r => r.data));
      return toText(res);
    }
    case 'chatwoot_get_conversation': {
      const res = await safeRequest(() =>
        http.get(`${acct(args)}/conversations/${args.id}`).then(r => r.data)
      );
      return toText(res);
    }
    case 'chatwoot_send_message': {
      const payload = {
        content: args.content,
        message_type: args.message_type ?? 'outgoing',
        private: args.private ?? false,
      };
      const res = await safeRequest(() =>
        http.post(`${acct(args)}/conversations/${args.conversation_id}/messages`, payload).then(r => r.data)
      );
      return toText(res);
    }
    case 'chatwoot_assign_conversation': {
      const payload: Record<string, unknown> = {};
      if (args.assignee_id) payload.assignee_id = args.assignee_id;
      if (args.team_id) payload.team_id = args.team_id;
      const res = await safeRequest(() =>
        http.patch(`${acct(args)}/conversations/${args.conversation_id}/assignments`, payload).then(r => r.data)
      );
      return toText(res);
    }
    case 'chatwoot_update_conversation_status': {
      const res = await safeRequest(() =>
        http.patch(`${acct(args)}/conversations/${args.conversation_id}`, { status: args.status }).then(r => r.data)
      );
      return toText(res);
    }
    case 'chatwoot_list_contacts': {
      const params: Record<string, unknown> = { page: args.page ?? 1 };
      if (args.q) params.q = args.q;
      const res = await safeRequest(() => http.get(`${acct(args)}/contacts`, { params }).then(r => r.data));
      return toText(res);
    }
    case 'chatwoot_create_contact': {
      const { account_id, ...contactData } = args;
      const res = await safeRequest(() => http.post(`${acct(args)}/contacts`, contactData).then(r => r.data));
      return toText(res);
    }
    case 'chatwoot_list_inboxes': {
      const res = await safeRequest(() => http.get(`${acct(args)}/inboxes`).then(r => r.data));
      return toText(res);
    }
    case 'chatwoot_list_agents': {
      const res = await safeRequest(() => http.get(`${acct(args)}/agents`).then(r => r.data));
      return toText(res);
    }
    case 'chatwoot_get_reports': {
      const params: Record<string, unknown> = { metric: args.metric, type: args.type };
      if (args.id) params.id = args.id;
      if (args.since) params.since = args.since;
      if (args.until) params.until = args.until;
      const res = await safeRequest(() =>
        http.get(`${acct(args)}/reports/agents/summary`, { params }).then(r => r.data)
      );
      return toText(res);
    }
    default:
      return `❌ Ferramenta desconhecida: ${name}`;
  }
}
