/**
 * provisioning.ts — Auto-provision Evolution instance + Chatwoot inbox + Qdrant collection
 * Called on: new agent creation, WooCommerce subscription webhook.
 */
import { config } from '../config.js';
import { getDb } from '../tools/mongodb.js';
import nodemailer from 'nodemailer';
import jwt from 'jsonwebtoken';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ProvisionTenantInput {
  email: string;
  name: string;
  woocommerceUserId?: string;
  plan?: string;
}

export interface TenantDoc {
  _id: string;
  email: string;
  name: string;
  woocommerceUserId?: string;
  plan: string;
  status: 'active' | 'suspended';
  createdAt: Date;
}

export interface ProvisionAgentInput {
  tenantId: string;
  name: string;
  phone?: string; // desired phone (display only — QR pairing determines actual number)
  systemPrompt: string;
  model?: string;
  tools?: string[];
}

export interface AgentDoc {
  _id: string; // string ID (not ObjectId)
  tenantId: string;
  name: string;
  evolutionInstance: string;
  chatwootInboxId?: number;
  systemPrompt: string;
  model: string;
  tools: string[];
  customApis: unknown[];
  groupConfig: { respondToMentions: boolean; respondToReplies: boolean; respondToAll: boolean };
  status: 'pending_qr' | 'active' | 'paused';
  createdAt: Date;
}

// ── Tenant provisioning ──────────────────────────────────────────────────────

// ── WooCommerce subscription check ──────────────────────────────────────────

export interface WcSubscriptionResult {
  hasAccess: boolean;
  wcUserId?: number;
  wcUserName?: string;
  plan?: string;
}

export async function checkWcSubscription(email: string): Promise<WcSubscriptionResult> {
  const { url, consumerKey, consumerSecret, subscriptionProductId } = config.woocommerce;
  if (!url || !consumerKey || !consumerSecret) {
    console.warn('[provisioning] WooCommerce credentials not configured — granting access');
    return { hasAccess: true };
  }

  const base64 = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  const headers = { Authorization: `Basic ${base64}`, 'Content-Type': 'application/json' };

  try {
    // Fetch active subscriptions for this email
    const params = new URLSearchParams({ email, status: 'active', per_page: '50' });
    const r = await fetch(`${url.replace(/\/$/, '')}/wp-json/wc/v1/subscriptions?${params}`, { headers });

    if (!r.ok) {
      console.error(`[provisioning] WC subscriptions check failed: ${r.status}`);
      return { hasAccess: false };
    }

    type WcSubscription = {
      id: number;
      customer_id: number;
      line_items: { product_id: number }[];
      billing: { first_name?: string; last_name?: string };
    };

    const subs = await r.json() as WcSubscription[];
    const match = subs.find(s =>
      s.line_items.some(li => li.product_id === subscriptionProductId)
    );

    if (!match) return { hasAccess: false };

    const wcUserName = [match.billing.first_name, match.billing.last_name].filter(Boolean).join(' ') || email;
    return { hasAccess: true, wcUserId: match.customer_id, wcUserName };
  } catch (e) {
    console.error('[provisioning] WC subscription check error:', String(e));
    return { hasAccess: false };
  }
}

// ── Find or create tenant (idempotent) ──────────────────────────────────────

export async function findOrCreateTenant(
  email: string,
  wcInfo?: { wcUserId?: number; wcUserName?: string },
): Promise<{ tenant: TenantDoc; isNew: boolean }> {
  const db = await getDb();
  const existing = await db.collection<TenantDoc>('tenants').findOne({ email });
  if (existing) return { tenant: existing, isNew: false };

  const tenantId = generateId();
  const name = wcInfo?.wcUserName ?? email.split('@')[0];

  const tenant: TenantDoc = {
    _id: tenantId,
    email,
    name,
    woocommerceUserId: wcInfo?.wcUserId ? String(wcInfo.wcUserId) : undefined,
    plan: 'starter',
    status: 'active',
    createdAt: new Date(),
  };

  await db.collection<TenantDoc>('tenants').insertOne(tenant);
  console.log(`[provisioning] Tenant created: ${tenantId} email=${email}`);
  return { tenant, isNew: true };
}

// ── Send magic link (for returning users and new users alike) ────────────────

export async function sendMagicLink(email: string, tenantId: string, name: string): Promise<void> {
  const token = jwt.sign({ tenantId, email }, config.jwt.secret, { expiresIn: '7d' });
  const loginUrl = `${config.app.url}/login?token=${token}`;
  await sendLoginEmail(email, name, loginUrl);
}

export async function provisionTenant(input: ProvisionTenantInput): Promise<TenantDoc> {
  const db = await getDb();
  const tenantId = generateId();

  const tenant: TenantDoc = {
    _id: tenantId,
    email: input.email,
    name: input.name,
    woocommerceUserId: input.woocommerceUserId,
    plan: input.plan ?? 'starter',
    status: 'active',
    createdAt: new Date(),
  };

  await db.collection<TenantDoc>('tenants').insertOne(tenant);

  // Generate login JWT and send welcome email
  const token = jwt.sign({ tenantId, email: input.email }, config.jwt.secret, { expiresIn: '7d' });
  const loginUrl = `${config.app.url}/login?token=${token}`;
  await sendWelcomeEmail(input.email, input.name, loginUrl);

  console.log(`[provisioning] Tenant created: ${tenantId} email=${input.email}`);
  return tenant;
}

// ── Agent provisioning ───────────────────────────────────────────────────────

export async function provisionAgent(input: ProvisionAgentInput): Promise<AgentDoc & { qrCodeUrl: string }> {
  const db = await getDb();
  const agentId = generateId();
  const instance = `agent_${agentId}`;

  // 1. Create Evolution instance + register webhook for connection updates
  const evolutionWebhookUrl = `${config.app.url}/webhook/evolution/${instance}`;
  await createEvolutionInstance(instance, evolutionWebhookUrl);

  // 2. Create Chatwoot inbox
  const inboxId = await createChatwootInbox(instance, input.name, agentId);

  // 3. Create Qdrant collection
  await createQdrantCollection(agentId);

  // 4. Save agent to MongoDB
  const agent: AgentDoc = {
    _id: agentId,
    tenantId: input.tenantId,
    name: input.name,
    evolutionInstance: instance,
    chatwootInboxId: inboxId ?? undefined,
    systemPrompt: input.systemPrompt,
    model: input.model ?? 'google/gemini-2.5-flash',
    tools: input.tools ?? ['evolution', 'chatwoot'],
    customApis: [],
    groupConfig: { respondToMentions: true, respondToReplies: true, respondToAll: false },
    status: 'pending_qr',
    createdAt: new Date(),
  };

  await db.collection<AgentDoc>('agents').insertOne(agent);

  // 5. QR code URL (Evolution serves it at this endpoint once instance is created)
  const qrCodeUrl = `${config.evolution.url}/instance/qrcode/${instance}`;

  console.log(`[provisioning] Agent created: ${agentId} instance=${instance} chatwootInbox=${inboxId}`);
  return { ...agent, qrCodeUrl };
}

// ── Delete agent (cleanup) ───────────────────────────────────────────────────

export async function deprovisionAgent(agentId: string, tenantId: string): Promise<void> {
  const db = await getDb();
  const agent = await db.collection<AgentDoc>('agents').findOne({ _id: agentId, tenantId });
  if (!agent) return;

  const evUrl = config.evolution.url.replace(/\/$/, '');
  const evHeaders = { apikey: config.evolution.apiKey };

  // Logout first (required for connected instances)
  try {
    const logoutRes = await fetch(`${evUrl}/instance/logout/${agent.evolutionInstance}`, {
      method: 'DELETE', headers: evHeaders,
    });
    console.log(`[provisioning] Evolution logout ${agent.evolutionInstance}: ${logoutRes.status}`);
  } catch (e) {
    console.warn(`[provisioning] Evolution logout failed (continuing):`, String(e));
  }

  // Delete Evolution instance
  try {
    const deleteRes = await fetch(`${evUrl}/instance/delete/${agent.evolutionInstance}`, {
      method: 'DELETE', headers: evHeaders,
    });
    console.log(`[provisioning] Evolution delete ${agent.evolutionInstance}: ${deleteRes.status}`);
    if (!deleteRes.ok) {
      const txt = await deleteRes.text();
      console.error(`[provisioning] Evolution delete error body: ${txt.slice(0, 300)}`);
    }
  } catch (e) {
    console.error(`[provisioning] Evolution delete failed:`, String(e));
  }

  // Delete Qdrant collection
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.qdrant.apiKey) headers['api-key'] = config.qdrant.apiKey;
    await fetch(`${config.qdrant.url.replace(/\/$/, '')}/collections/agent_${agentId}`, {
      method: 'DELETE',
      headers,
    });
  } catch (e) {
    console.error(`[provisioning] Qdrant collection delete failed:`, String(e));
  }

  await db.collection<AgentDoc>('agents').deleteOne({ _id: agentId, tenantId });
  console.log(`[provisioning] Agent deprovisioned: ${agentId}`);
}

// ── Evolution ────────────────────────────────────────────────────────────────

async function createEvolutionInstance(instance: string, webhookUrl: string): Promise<void> {
  const evUrl = config.evolution.url.replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json', apikey: config.evolution.apiKey };

  const r = await fetch(`${evUrl}/instance/create`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      instanceName: instance,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Evolution instance create failed: ${r.status} ${txt.slice(0, 200)}`);
  }

  // Register webhook so Evolution notifies us on CONNECTION_UPDATE
  try {
    const wRes = await fetch(`${evUrl}/webhook/set/${instance}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url: webhookUrl,
        enabled: true,
        webhookBase64: false,
        webhookByEvents: false,
        events: ['CONNECTION_UPDATE', 'QRCODE_UPDATED'],
      }),
    });
    console.log(`[provisioning] Evolution webhook set ${instance}: ${wRes.status}`);
  } catch (e) {
    console.warn(`[provisioning] Evolution webhook set failed (non-fatal):`, String(e));
  }
}

// ── Chatwoot ─────────────────────────────────────────────────────────────────

async function createChatwootInbox(instance: string, name: string, agentId: string): Promise<number | null> {
  const webhookUrl = `${config.app.url}/webhook/chatwoot/${agentId}`;
  const acctId = config.chatwoot.accountId;
  const evUrl = config.evolution.url.replace(/\/$/, '');

  // Strategy 1: Evolution's built-in Chatwoot integration
  // This links the WhatsApp instance directly to a Chatwoot inbox (messages flow automatically)
  try {
    const r = await fetch(`${evUrl}/chatwoot/create/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.evolution.apiKey },
      body: JSON.stringify({
        enabled: true,
        account_id: acctId,
        token: config.chatwoot.apiKey,
        url: config.chatwoot.url,
        name_inbox: name,
        sign_msg: false,
        reopen_conversation: true,
        conversation_pending: false,
        auto_create: true,
        webhook_url: webhookUrl,
      }),
    });

    const rawBody = await r.text();
    console.log(`[provisioning] Evolution Chatwoot create ${instance}: status=${r.status} body=${rawBody.slice(0, 400)}`);

    if (r.ok) {
      // Evolution v2 returns: { chatwoot: { inbox_id: N, ... } }
      // Some builds return: { inbox: { id: N } } or { id: N }
      type EvCwResp = {
        chatwoot?: { inbox_id?: number };
        inbox?: { id?: number };
        id?: number;
        inbox_id?: number;
      };
      const data = JSON.parse(rawBody) as EvCwResp;
      const inboxId = data.chatwoot?.inbox_id ?? data.inbox?.id ?? data.id ?? data.inbox_id ?? null;
      if (inboxId) {
        console.log(`[provisioning] Chatwoot inbox linked via Evolution: inboxId=${inboxId}`);
        await registerChatwootWebhook(Number(acctId), inboxId, webhookUrl);
        return inboxId;
      }
      console.warn(`[provisioning] Evolution Chatwoot create OK but could not extract inbox_id from response`);
    }
  } catch (e) {
    console.error(`[provisioning] Evolution Chatwoot create error:`, String(e));
  }

  // Strategy 2: Create inbox directly via Chatwoot API (fallback — no Evolution link)
  // Warning: messages from WhatsApp won't flow automatically; Chatwoot only acts as conversation store
  try {
    const r2 = await fetch(`${config.chatwoot.url}/api/v1/accounts/${acctId}/inboxes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api_access_token': config.chatwoot.apiKey,
      },
      body: JSON.stringify({ channel: { type: 'api', webhook_url: webhookUrl }, name }),
    });
    const rawBody2 = await r2.text();
    console.log(`[provisioning] Chatwoot direct inbox create: status=${r2.status} body=${rawBody2.slice(0, 200)}`);
    if (r2.ok) {
      const data2 = JSON.parse(rawBody2) as { id?: number };
      if (data2.id) {
        console.warn(`[provisioning] Chatwoot inbox created directly (NOT linked to Evolution): inboxId=${data2.id}`);
        return data2.id;
      }
    }
  } catch (e) {
    console.error(`[provisioning] Chatwoot direct inbox create error:`, String(e));
  }

  console.error(`[provisioning] Failed to create Chatwoot inbox for agent=${agentId} instance=${instance}`);
  return null;
}

async function registerChatwootWebhook(accountId: number, inboxId: number, webhookUrl: string): Promise<void> {
  try {
    await fetch(`${config.chatwoot.url}/api/v1/accounts/${accountId}/integrations/webhooks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api_access_token': config.chatwoot.apiKey,
      },
      body: JSON.stringify({
        url: webhookUrl,
        subscriptions: ['message_created', 'conversation_updated'],
      }),
    });
  } catch (e) {
    console.error(`[provisioning] Chatwoot webhook register failed:`, String(e));
  }
}

// ── Qdrant ───────────────────────────────────────────────────────────────────

async function createQdrantCollection(agentId: string): Promise<void> {
  const collection = `agent_${agentId}`;
  const base = config.qdrant.url.replace(/\/$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.qdrant.apiKey) headers['api-key'] = config.qdrant.apiKey;

  try {
    const r = await fetch(`${base}/collections/${collection}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        vectors: { size: 1536, distance: 'Cosine' }, // text-embedding-3-small dimension
      }),
    });
    if (!r.ok) {
      const txt = await r.text();
      console.error(`[provisioning] Qdrant collection create failed: ${r.status} ${txt.slice(0, 200)}`);
    } else {
      console.log(`[provisioning] Qdrant collection created: ${collection}`);
    }
  } catch (e) {
    console.error(`[provisioning] Qdrant collection create error:`, String(e));
  }
}

// ── Email ────────────────────────────────────────────────────────────────────

async function sendLoginEmail(email: string, name: string, loginUrl: string): Promise<void> {
  if (!config.smtp.host) {
    console.log(`[provisioning] SMTP not configured — magic link: ${loginUrl}`);
    return;
  }
  try {
    const transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      auth: { user: config.smtp.user, pass: config.smtp.password },
    });
    await transporter.sendMail({
      from: config.smtp.from,
      to: email,
      subject: 'Seu link de acesso ao Vendly',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
          <h2 style="color:#0d9488">Vendly</h2>
          <p>Olá${name ? ` ${name}` : ''},</p>
          <p>Clique no botão abaixo para acessar seu painel. O link expira em 7 dias.</p>
          <p style="margin:32px 0">
            <a href="${loginUrl}"
               style="background:#0d9488;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">
              Acessar o painel
            </a>
          </p>
          <p style="color:#888;font-size:13px">Se não solicitou este acesso, ignore este email.</p>
        </div>
      `,
    });
    console.log(`[provisioning] Magic link sent to ${email}`);
  } catch (e) {
    console.error(`[provisioning] Email send failed:`, String(e));
  }
}

async function sendWelcomeEmail(email: string, name: string, loginUrl: string): Promise<void> {
  return sendLoginEmail(email, name, loginUrl);
}

// ── Utils ────────────────────────────────────────────────────────────────────

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
