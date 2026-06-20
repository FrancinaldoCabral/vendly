import { getToken } from './auth';
import type { Tenant, Agent, KnowledgePoint, ScheduledPost, Conversation, Connection, ContactFilter, CatalogTool, ProvisionIssue } from './types';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    // 401 mid-session = expired token or a subscription that is no longer active. Drop the token
    // and send the user back to login (where the reason is shown). Skip for the auth endpoints
    // themselves so their own error messages still surface on the login screen.
    if (res.status === 401 && !path.startsWith('/auth/')) {
      localStorage.removeItem('smcp_token');
      if (!location.pathname.startsWith('/login')) location.assign('/login');
    }
    throw new Error(err.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // Auth
  login: (email: string, password: string) =>
    req<{ token: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  requestMagicLink: (email: string) =>
    req<{ ok: boolean }>('/auth/request-link', { method: 'POST', body: JSON.stringify({ email }) }),
  exchangeMagicToken: (magicToken: string) =>
    req<{ token: string }>('/auth/token', { method: 'POST', body: JSON.stringify({ token: magicToken }) }),

  // Tenant
  getMe: () => req<Tenant>('/tenants/me'),
  updateMe: (data: Partial<Tenant>) =>
    req<Tenant>('/tenants/me', { method: 'PUT', body: JSON.stringify(data) }),
  getCrmLink: () => req<{ url: string }>('/tenants/me/chatwoot-sso'),

  // WhatsApp connections
  getConnections: () => req<Connection[]>('/connections'),
  createConnection: (name: string) =>
    req<{ connection: Connection; qrCodeUrl: string }>('/connections', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteConnection: (id: string) => req<{ ok: boolean }>(`/connections/${id}`, { method: 'DELETE' }),
  getConnectionQr: (id: string) => req<{ base64: string | null; code: string | null }>(`/connections/${id}/qr`),
  getConnectionStatus: (id: string) => req<{ connected: boolean; connectionStatus: string }>(`/connections/${id}/status`),
  getConnectionGroups: (id: string) => req<{ id: string; subject: string }[]>(`/connections/${id}/groups`),

  // Provisioning health (self-service repair of failed onboarding)
  getProvisioningHealth: () =>
    req<{ healthy: boolean; issues: ProvisionIssue[] }>('/health/provisioning'),
  repairProvisioning: () =>
    req<{ ok: boolean; fixed: string[]; issues: ProvisionIssue[] }>('/health/repair', { method: 'POST' }),

  // Tool catalog (friendly built-in tools)
  getToolCatalog: () => req<CatalogTool[]>('/tool-catalog'),

  // Upload a file to object storage (returns a public URL)
  uploadFile: async (file: File) => {
    const dataBase64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    return req<{ url: string }>('/uploads', {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, contentType: file.type, dataBase64 }),
    });
  },

  // Agents
  getAgents: () => req<Agent[]>('/agents'),
  getAgent: (id: string) => req<Agent>(`/agents/${id}`),
  createAgent: (data: Partial<Agent>) =>
    req<{ agent: Agent; qrCodeUrl: string }>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (id: string, data: Partial<Agent>) =>
    req<Agent>(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAgent: (id: string) => req<{ ok: boolean }>(`/agents/${id}`, { method: 'DELETE' }),
  clearAgentHistory: (id: string, phone?: string) =>
    req<{ ok: boolean; scope: string; keysDeleted: number; recordsDeleted: number }>(`/agents/${id}/clear-history`, { method: 'POST', body: JSON.stringify({ phone: phone ?? '' }) }),
  pauseAllAgents: () => req<{ ok: boolean; paused: number }>('/agents/pause-all', { method: 'POST' }),
  resumeAllAgents: () => req<{ ok: boolean; resumed: number }>('/agents/resume-all', { method: 'POST' }),
  getAgentQr: (id: string) => req<{ base64: string | null; code: string | null }>(`/agents/${id}/qr`),
  getAgentStatus: (id: string) => req<{ agentStatus: string; connected: boolean }>(`/agents/${id}/status`),
  getContactFilter: (id: string) => req<{ contactFilter: ContactFilter }>(`/agents/${id}/contact-filter`),
  setContactFilter: (id: string, filter: ContactFilter) =>
    req<{ contactFilter: ContactFilter }>(`/agents/${id}/contact-filter`, { method: 'PUT', body: JSON.stringify(filter) }),

  // Knowledge
  getKnowledge: (agentId: string, params?: Record<string, string>) => {
    const q = new URLSearchParams({ agentId, ...params }).toString();
    return req<{ data: KnowledgePoint[] }>(`/knowledge?${q}`);
  },
  createKnowledge: (data: { title: string; text: string; category?: string; agentId: string }) =>
    req<{ id: number; payload: KnowledgePoint['payload'] }>('/knowledge', { method: 'POST', body: JSON.stringify(data) }),
  updateKnowledge: (id: number, agentId: string, data: { title?: string; text?: string; category?: string }) =>
    req<{ ok: boolean }>(`/knowledge/${id}?agentId=${agentId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteKnowledge: (id: number, agentId: string) =>
    req<{ ok: boolean }>(`/knowledge/${id}?agentId=${agentId}`, { method: 'DELETE' }),

  // Scheduled posts
  getScheduledPosts: (agentId?: string) => {
    const q = agentId ? `?agentId=${agentId}` : '';
    return req<ScheduledPost[]>(`/scheduled_posts${q}`);
  },
  createScheduledPost: (data: Partial<ScheduledPost>) =>
    req<ScheduledPost>('/scheduled_posts', { method: 'POST', body: JSON.stringify(data) }),
  updateScheduledPost: (id: string, data: Partial<ScheduledPost>) =>
    req<ScheduledPost>(`/scheduled_posts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteScheduledPost: (id: string) =>
    req<{ ok: boolean }>(`/scheduled_posts/${id}`, { method: 'DELETE' }),
  toggleScheduledPost: (id: string) =>
    req<{ ok: boolean; status: string }>(`/scheduled_posts/${id}/pause`, { method: 'POST' }),

  // Conversations
  getConversations: (params?: Record<string, string>) => {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    return req<{ data: Conversation[]; total: number }>(`/conversations${q}`);
  },
  clearSession: (agentId: string, conversationId: string) =>
    req<{ ok: boolean }>(`/conversations/session?agentId=${agentId}&conversationId=${conversationId}`, { method: 'DELETE' }),
};
