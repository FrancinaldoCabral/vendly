import { getToken } from './auth';
import type { Tenant, Agent, KnowledgePoint, ScheduledPost, Conversation } from './types';

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

  // Agents
  getAgents: () => req<Agent[]>('/agents'),
  getAgent: (id: string) => req<Agent>(`/agents/${id}`),
  createAgent: (data: Partial<Agent>) =>
    req<{ agent: Agent; qrCodeUrl: string }>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (id: string, data: Partial<Agent>) =>
    req<Agent>(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAgent: (id: string) => req<{ ok: boolean }>(`/agents/${id}`, { method: 'DELETE' }),
  getAgentQr: (id: string) => req<{ base64: string | null; code: string | null }>(`/agents/${id}/qr`),
  getAgentStatus: (id: string) => req<{ status: string }>(`/agents/${id}/status`),

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
