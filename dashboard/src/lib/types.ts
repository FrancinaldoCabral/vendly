export interface Tenant {
  _id: string;
  email: string;
  name: string;
  plan?: string;
  status: 'active' | 'suspended';
  woocommerceUserId?: string;
  createdAt?: string;
}

export interface CustomApi {
  name: string;
  description: string;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: { key: string; value: string }[];
  schema: Record<string, unknown>;
  kind?: 'responding' | 'void' | 'async';
  waitingMessage?: string;
}

export interface Connection {
  _id: string;
  tenantId: string;
  name: string;
  evolutionInstance?: string;
  status: 'pending_qr' | 'active' | 'paused';
  agentCount?: number;
  createdAt?: string;
}

export interface ContactFilter {
  mode: 'blacklist' | 'whitelist';
  contacts: string[];
  groups: string[];
}

export interface CatalogTool {
  id: string;
  label: string;
  description: string;
  category: string;
  behavior: string;
}

export interface GroupConfig {
  respondToMentions: boolean;
  respondToReplies: boolean;
  respondToAll: boolean;
}

export interface Agent {
  _id: string;
  tenantId: string;
  connectionId?: string;
  name: string;
  assistantName?: string;
  evolutionInstance?: string;
  chatwootInboxId?: string;
  systemPrompt?: string;
  tools: string[];
  builtinTools?: string[];
  customApis: CustomApi[];
  groupConfig?: GroupConfig;
  contactFilter?: ContactFilter;
  priority?: number;
  model?: string;
  temperature?: number;
  maxIter?: number;
  status: 'pending_qr' | 'active' | 'paused' | 'error';
  createdAt?: string;
}

export interface KnowledgePoint {
  id: number;
  payload: {
    title: string;
    text: string;
    category: string;
    agentId: string;
    tenantId: string;
    createdAt?: string;
  };
}

export type PipelineStepType = 'search' | 'image_gen' | 'fetch_url' | 'compose';

export interface PipelineStep {
  type: PipelineStepType;
  config: Record<string, unknown>;
}

export interface ScheduleConfig {
  days: number[];
  time: string;
  timezone?: string;
}

export interface PostTarget {
  type: 'contact' | 'group' | 'status';
  jid: string;
}

export interface ScheduledPost {
  _id: string;
  agentId: string;
  tenantId: string;
  schedule: ScheduleConfig;
  pipeline: PipelineStep[];
  targets: PostTarget[];
  status: 'active' | 'paused';
  lastRun?: string;
  createdAt?: string;
}

export interface Conversation {
  _id: string;
  agentId: string;
  tenantId: string;
  senderPhone: string;
  senderName?: string;
  chatwootConvId?: number;
  messages: { role: string; content: string }[];
  createdAt?: string;
  updatedAt?: string;
}
