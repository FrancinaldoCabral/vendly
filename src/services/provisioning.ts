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
  chatwoot?: {
    accountId: number;
    userId?: number;  // Chatwoot platform user ID (for SSO regeneration)
    apiKey: string;  // user's api_access_token for runtime Chatwoot API calls
    ssoUrl: string;  // last-known SSO login link (regenerated on demand via /me/chatwoot-sso)
  };
}

export interface ProvisionAgentInput {
  tenantId: string;
  name: string;
  phone?: string; // desired phone (display only — QR pairing determines actual number)
  systemPrompt: string;
  model?: string;
  tools?: string[];
  builtinTools?: string[];
  assets?: AgentDoc['assets'];
  assistantName?: string;
  customApis?: unknown[];
  groupConfig?: { respondToMentions: boolean; respondToReplies: boolean; respondToAll: boolean };
  contactFilter?: { mode: 'blacklist' | 'whitelist'; contacts: string[]; groups: string[] };
  /** Attach to an existing WhatsApp connection. If omitted, a new one is created (1:1 legacy). */
  connectionId?: string;
}

/**
 * A WhatsApp connection (Evolution instance + Chatwoot inbox) owned by the negócio
 * (tenant). One connection can be shared by many agents — each agent filters which
 * chats it handles via its contactFilter. This is how the livraeats model works:
 * one number, multiple agents.
 */
export interface ConnectionDoc {
  _id: string;
  tenantId: string;
  name: string;
  evolutionInstance: string;
  chatwootInboxId?: number;
  status: 'pending_qr' | 'active' | 'paused';
  createdAt: Date;
}

export interface AgentDoc {
  _id: string; // string ID (not ObjectId)
  tenantId: string;
  connectionId: string;           // which WhatsApp connection this agent listens on
  name: string;
  assistantName?: string;
  evolutionInstance: string;      // denormalized from the connection (keeps message flow simple)
  chatwootInboxId?: number;       // denormalized from the connection
  systemPrompt: string;
  model: string;
  temperature?: number;
  maxIter?: number;
  tools: string[];
  builtinTools: string[];
  assets?: {
    polls?: Array<{ label: string; question: string; options: string[]; multiple?: boolean }>;
    reactions?: string[];
    files?: Array<{ label: string; url: string; mediatype?: string; mimetype?: string; fileName?: string; caption?: string }>;
    locations?: Array<{ label: string; name: string; address: string; latitude: number; longitude: number }>;
    contacts?: Array<{ label: string; fullName: string; phone: string; organization?: string; email?: string; url?: string }>;
  };
  customApis: unknown[];
  groupConfig: { respondToMentions: boolean; respondToReplies: boolean; respondToAll: boolean };
  contactFilter: { mode: 'blacklist' | 'whitelist'; contacts: string[]; groups: string[] };
  priority: number;               // lower = checked first when a connection is shared
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
): Promise<{ tenant: TenantDoc; isNew: boolean; chatwootSsoUrl?: string }> {
  const db = await getDb();
  const existing = await db.collection<TenantDoc>('tenants').findOne({ email });

  // Tenant exists — heal missing Chatwoot account if needed (e.g. transient failure on prior login)
  if (existing) {
    if (!existing.chatwoot) {
      console.log(`[provisioning] Tenant ${existing._id} missing Chatwoot — retrying creation`);
      const cwAccount = await createChatwootAccount(email, existing.name, existing._id);
      if (cwAccount) {
        await db.collection<TenantDoc>('tenants').updateOne(
          { _id: existing._id },
          { $set: { chatwoot: { accountId: cwAccount.accountId, userId: cwAccount.userId, apiKey: cwAccount.apiKey, ssoUrl: cwAccount.ssoUrl } } },
        );
        existing.chatwoot = { accountId: cwAccount.accountId, userId: cwAccount.userId, apiKey: cwAccount.apiKey, ssoUrl: cwAccount.ssoUrl };
        console.log(`[provisioning] Tenant ${existing._id} Chatwoot healed: accountId=${cwAccount.accountId}`);
      }
    }
    return { tenant: existing, isNew: false };
  }

  const tenantId = generateId();
  const name = wcInfo?.wcUserName ?? email.split('@')[0];

  // Create Chatwoot account for this tenant (uses internal email to avoid conflicts with existing Chatwoot users)
  const cwAccount = await createChatwootAccount(email, name, tenantId);
  if (!cwAccount) {
    throw new Error('Falha ao criar conta no CRM. Tente novamente em instantes.');
  }

  const tenant: TenantDoc = {
    _id: tenantId,
    email,
    name,
    woocommerceUserId: wcInfo?.wcUserId ? String(wcInfo.wcUserId) : undefined,
    plan: 'starter',
    status: 'active',
    createdAt: new Date(),
    chatwoot: { accountId: cwAccount.accountId, userId: cwAccount.userId, apiKey: cwAccount.apiKey, ssoUrl: cwAccount.ssoUrl },
  };

  await db.collection<TenantDoc>('tenants').insertOne(tenant);
  console.log(`[provisioning] Tenant created: ${tenantId} email=${email} chatwootAccountId=${cwAccount.accountId}`);
  return { tenant, isNew: true, chatwootSsoUrl: cwAccount.ssoUrl };
}

// ── Send magic link (for returning users and new users alike) ────────────────

export async function sendMagicLink(email: string, tenantId: string, name: string): Promise<void> {
  const token = jwt.sign({ tenantId, email }, config.jwt.secret, { expiresIn: '7d' });
  const loginUrl = `${config.app.url}/login?token=${token}`;
  await sendLoginEmail(email, name, loginUrl);
}

export async function sendWelcomeEmailWithChatwoot(
  email: string,
  name: string,
  tenantId: string,
  chatwootSsoUrl: string,
): Promise<void> {
  const token = jwt.sign({ tenantId, email }, config.jwt.secret, { expiresIn: '30d' });
  const dashboardUrl = `${config.app.url}/login?token=${token}`;

  if (!config.smtp.host) {
    console.log(`[provisioning] SMTP not configured — dashboard=${dashboardUrl} chatwoot_sso=${chatwootSsoUrl}`);
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
      subject: 'Bem-vindo ao Vendly — seus acessos',
      html: `
        <div style="font-family:sans-serif;max-width:540px;margin:0 auto">
          <h2 style="color:#0d9488">Vendly</h2>
          <p>Olá${name ? ` ${name}` : ''},</p>
          <p>Sua conta foi criada. Aqui estão seus dois acessos:</p>

          <h3 style="margin-top:24px">1. Painel de Controle</h3>
          <p>Configure seus agentes, conecte o WhatsApp e acompanhe tudo:</p>
          <p style="margin:16px 0">
            <a href="${dashboardUrl}"
               style="background:#0d9488;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">
              Acessar o Painel
            </a>
          </p>

          <h3 style="margin-top:24px">2. CRM de Conversas</h3>
          <p>Veja todas as conversas do WhatsApp, responda manualmente, adicione labels e gerencie sua equipe:</p>
          <p style="margin:16px 0">
            <a href="${chatwootSsoUrl}"
               style="background:#1f93ff;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">
              Acessar o CRM
            </a>
          </p>
          <p style="color:#888;font-size:13px">O link do CRM faz login automático. Após entrar, defina uma senha nas configurações de perfil.</p>

          <p style="color:#888;font-size:13px;margin-top:32px">Se não solicitou este acesso, ignore este email.</p>
        </div>
      `,
    });
    console.log(`[provisioning] Welcome email sent to ${email}`);
  } catch (e) {
    console.error(`[provisioning] Welcome email failed:`, String(e));
  }
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

/** Ensure the tenant has a Chatwoot account, creating/healing it if needed. Returns creds. */
async function ensureTenantChatwoot(tenantId: string): Promise<{ accountId: number; apiKey: string }> {
  const db = await getDb();
  let tenant = await db.collection<TenantDoc>('tenants').findOne({ _id: tenantId });
  if (!tenant) throw new Error(`Tenant ${tenantId} not found.`);

  if (!tenant.chatwoot) {
    console.log(`[provisioning] tenant ${tenantId} missing Chatwoot — creating now`);
    const cwAccount = await createChatwootAccount(tenant.email, tenant.name, tenantId);
    if (!cwAccount) throw new Error(`Cannot provision: failed to create Chatwoot account for tenant ${tenantId}.`);
    await db.collection<TenantDoc>('tenants').updateOne(
      { _id: tenantId } as Record<string, unknown>,
      { $set: { chatwoot: { accountId: cwAccount.accountId, userId: cwAccount.userId, apiKey: cwAccount.apiKey, ssoUrl: cwAccount.ssoUrl } } },
    );
    tenant = { ...tenant, chatwoot: { accountId: cwAccount.accountId, userId: cwAccount.userId, apiKey: cwAccount.apiKey, ssoUrl: cwAccount.ssoUrl } };
  }
  const cw = tenant.chatwoot as NonNullable<TenantDoc['chatwoot']>;
  return { accountId: cw.accountId, apiKey: cw.apiKey };
}

/**
 * Create a WhatsApp connection for a tenant: Evolution instance + Chatwoot inbox.
 * Agents are attached to a connection separately.
 */
export async function provisionConnection(
  tenantId: string,
  name: string,
): Promise<ConnectionDoc & { qrCodeUrl: string }> {
  const db = await getDb();
  const connectionId = generateId();
  const instance = `conn_${connectionId}`;

  const { accountId: cwAccountId, apiKey: cwApiKey } = await ensureTenantChatwoot(tenantId);

  // Evolution instance + webhook
  const evolutionWebhookUrl = `${config.app.url}/webhook/evolution/${instance}`;
  await createEvolutionInstance(instance, evolutionWebhookUrl);

  // Chatwoot inbox (one per connection — all agents on this number share the CRM stream)
  const inboxId = await createChatwootInbox(instance, name, connectionId, cwAccountId, cwApiKey);

  const connection: ConnectionDoc = {
    _id: connectionId,
    tenantId,
    name,
    evolutionInstance: instance,
    chatwootInboxId: inboxId ?? undefined,
    status: 'pending_qr',
    createdAt: new Date(),
  };
  await db.collection<ConnectionDoc>('connections').insertOne(connection);

  const qrCodeUrl = `${config.evolution.url}/instance/qrcode/${instance}`;
  console.log(`[provisioning] Connection created: ${connectionId} instance=${instance} chatwootInbox=${inboxId}`);
  return { ...connection, qrCodeUrl };
}

export async function provisionAgent(input: ProvisionAgentInput): Promise<AgentDoc & { qrCodeUrl: string }> {
  const db = await getDb();
  const agentId = generateId();

  // 1. Resolve the connection: use the given one, or create a fresh one (legacy 1:1).
  let connection: ConnectionDoc | null = null;
  if (input.connectionId) {
    connection = await db.collection<ConnectionDoc>('connections').findOne({
      _id: input.connectionId, tenantId: input.tenantId,
    });
    if (!connection) throw new Error(`Connection ${input.connectionId} not found for tenant ${input.tenantId}.`);
  } else {
    connection = await provisionConnection(input.tenantId, input.name);
  }

  // 2. Per-agent Qdrant collection (each agent keeps its own knowledge base)
  await createQdrantCollection(agentId);

  // 3. Agent priority = position among existing agents on the same connection
  const siblings = await db.collection<AgentDoc>('agents').countDocuments({
    tenantId: input.tenantId, connectionId: connection._id,
  });

  // 4. Save agent (denormalize instance + inbox from the connection)
  const agent: AgentDoc = {
    _id: agentId,
    tenantId: input.tenantId,
    connectionId: connection._id,
    name: input.name,
    assistantName: input.assistantName,
    evolutionInstance: connection.evolutionInstance,
    chatwootInboxId: connection.chatwootInboxId,
    systemPrompt: input.systemPrompt,
    model: input.model ?? config.openrouter.chatModel,
    tools: input.tools ?? [],
    builtinTools: input.builtinTools ?? [],
    assets: input.assets ?? {},
    customApis: input.customApis ?? [],
    groupConfig: input.groupConfig ?? { respondToMentions: true, respondToReplies: true, respondToAll: false },
    contactFilter: input.contactFilter ?? { mode: 'blacklist', contacts: [], groups: [] }, // default: empty blacklist → everyone passes
    priority: siblings, // appended after existing agents
    status: connection.status, // shares the connection's connection-state
    createdAt: new Date(),
  };

  await db.collection<AgentDoc>('agents').insertOne(agent);

  const qrCodeUrl = `${config.evolution.url}/instance/qrcode/${connection.evolutionInstance}`;
  console.log(`[provisioning] Agent created: ${agentId} connection=${connection._id} instance=${connection.evolutionInstance}`);
  return { ...agent, qrCodeUrl };
}

// ── Delete agent (cleanup) ───────────────────────────────────────────────────

export async function deprovisionAgent(agentId: string, tenantId: string): Promise<void> {
  const db = await getDb();
  // Allow admin calls (empty tenantId) to find by id alone
  const filter: Record<string, unknown> = { _id: agentId };
  if (tenantId) filter.tenantId = tenantId;
  const agent = await db.collection<AgentDoc>('agents').findOne(filter);
  if (!agent) {
    console.warn(`[provisioning] deprovisionAgent: not found agentId=${agentId} tenantId=${tenantId}`);
    return;
  }

  // 1. Delete the agent's own Qdrant collection
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.qdrant.apiKey) headers['api-key'] = config.qdrant.apiKey;
    await fetch(`${config.qdrant.url.replace(/\/$/, '')}/collections/agent_${agentId}`, {
      method: 'DELETE', headers,
    });
    console.log(`[provisioning] Qdrant collection deleted: agent_${agentId}`);
  } catch (e) {
    console.error(`[provisioning] Qdrant collection delete failed:`, String(e));
  }

  // 2. Remove the agent doc
  await db.collection<AgentDoc>('agents').deleteOne(filter);

  // 3. Tear down the WhatsApp connection ONLY if no other agent still uses it.
  const connId = (agent as { connectionId?: string }).connectionId;
  const sharedQuery: Record<string, unknown> = connId
    ? { connectionId: connId }
    : { evolutionInstance: agent.evolutionInstance };
  const remaining = await db.collection<AgentDoc>('agents').countDocuments(sharedQuery);
  if (remaining === 0) {
    await teardownEvolutionAndInbox(agent.evolutionInstance, agent.chatwootInboxId, agent.tenantId);
    if (connId) {
      await db.collection<ConnectionDoc>('connections').deleteOne({ _id: connId });
    }
    console.log(`[provisioning] Connection torn down (last agent): instance=${agent.evolutionInstance}`);
  } else {
    console.log(`[provisioning] Connection kept (${remaining} agent(s) remain): instance=${agent.evolutionInstance}`);
  }

  console.log(`[provisioning] Agent deprovisioned: ${agentId} instance=${agent.evolutionInstance}`);
}

/** Delete a connection and its underlying Evolution instance + Chatwoot inbox (and detach agents). */
export async function deprovisionConnection(connectionId: string, tenantId: string): Promise<void> {
  const db = await getDb();
  const filter: Record<string, unknown> = { _id: connectionId };
  if (tenantId) filter.tenantId = tenantId;
  const connection = await db.collection<ConnectionDoc>('connections').findOne(filter);
  if (!connection) {
    console.warn(`[provisioning] deprovisionConnection: not found ${connectionId}`);
    return;
  }
  await teardownEvolutionAndInbox(connection.evolutionInstance, connection.chatwootInboxId, connection.tenantId);
  // Detach any agents still pointing at it (they become unusable until reassigned)
  await db.collection<AgentDoc>('agents').deleteMany({ connectionId });
  await db.collection<ConnectionDoc>('connections').deleteOne(filter);
  console.log(`[provisioning] Connection deprovisioned: ${connectionId} instance=${connection.evolutionInstance}`);
}

/** Shared teardown: logout + delete Evolution instance and delete the Chatwoot inbox. */
async function teardownEvolutionAndInbox(instance: string, inboxId: number | undefined, tenantId: string): Promise<void> {
  const evUrl = config.evolution.url.replace(/\/$/, '');
  const evHeaders = { apikey: config.evolution.apiKey };

  try {
    const r = await fetch(`${evUrl}/instance/logout/${instance}`, { method: 'DELETE', headers: evHeaders });
    console.log(`[provisioning] Evolution logout ${instance}: ${r.status}`);
  } catch (e) {
    console.warn(`[provisioning] Evolution logout failed (continuing):`, String(e));
  }
  try {
    const r = await fetch(`${evUrl}/instance/delete/${instance}`, { method: 'DELETE', headers: evHeaders });
    const body = await r.text();
    console.log(`[provisioning] Evolution delete ${instance}: ${r.status} ${body.slice(0, 200)}`);
  } catch (e) {
    console.error(`[provisioning] Evolution delete failed:`, String(e));
  }

  if (inboxId) {
    try {
      const db = await getDb();
      const tenant = await db.collection<TenantDoc>('tenants').findOne({ _id: tenantId });
      if (tenant?.chatwoot) {
        const cwUrl = config.chatwoot.url.replace(/\/$/, '');
        const r = await fetch(`${cwUrl}/api/v1/accounts/${tenant.chatwoot.accountId}/inboxes/${inboxId}`, {
          method: 'DELETE', headers: { 'api_access_token': tenant.chatwoot.apiKey },
        });
        console.log(`[provisioning] Chatwoot inbox delete ${inboxId}: ${r.status}`);
      }
    } catch (e) {
      console.error(`[provisioning] Chatwoot inbox delete failed:`, String(e));
    }
  }
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

  // Register webhook — CONNECTION_UPDATE for QR/connect events, MESSAGES_UPSERT for direct message delivery
  await setEvolutionWebhook(instance, webhookUrl, evUrl, headers);
}

async function setEvolutionWebhook(
  instance: string,
  webhookUrl: string,
  evUrl: string,
  headers: Record<string, string>,
): Promise<void> {
  try {
    const wRes = await fetch(`${evUrl}/webhook/set/${instance}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        webhook: {
          url: webhookUrl,
          enabled: true,
          webhookBase64: false,
          webhookByEvents: false,
          events: ['CONNECTION_UPDATE', 'QRCODE_UPDATED', 'MESSAGES_UPSERT'],
        },
      }),
    });
    const wBody = await wRes.text();
    console.log(`[provisioning] Evolution webhook set ${instance}: ${wRes.status} ${wBody.slice(0, 200)}`);
  } catch (e) {
    console.warn(`[provisioning] Evolution webhook set failed (non-fatal):`, String(e));
  }
}

/** Update webhook for an existing Evolution instance to include MESSAGES_UPSERT (safe to call repeatedly). */
export async function reprovisionEvolutionWebhook(instance: string): Promise<void> {
  const evUrl = config.evolution.url.replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json', apikey: config.evolution.apiKey };
  const webhookUrl = `${config.app.url}/webhook/evolution/${instance}`;
  await setEvolutionWebhook(instance, webhookUrl, evUrl, headers);
}

// ── Chatwoot ─────────────────────────────────────────────────────────────────

// Creates a new isolated Chatwoot account + admin user via Platform API.
// Returns { accountId, apiKey, ssoUrl } or null on failure.
// Verified against production: all 4 steps return 200.
export async function createChatwootAccount(
  tenantEmail: string,
  name: string,
  tenantId: string,
): Promise<{ accountId: number; userId: number; apiKey: string; ssoUrl: string } | null> {
  const cwUrl = config.chatwoot.url.replace(/\/$/, '');
  const platKey = config.chatwoot.platformKey;
  const platHeaders = { 'Content-Type': 'application/json', 'api_access_token': platKey };

  if (!platKey) {
    console.error('[provisioning] CHATWOOT_PLATFORM_KEY not configured');
    return null;
  }

  const realEmail = tenantEmail.trim().toLowerCase();
  // Fallback alias used ONLY if the real email is already taken in Chatwoot (rare —
  // e.g. it's the platform super-admin, or a leftover user). Kept on the same domain
  // so it stays recognizable; login is via SSO anyway.
  const [local, domain] = realEmail.split('@');
  const aliasEmail = `${local || 'user'}+t${tenantId}@${domain || 'accounts.vendly.chat'}`;

  try {
    // Step 1: create isolated account
    const r1 = await fetch(`${cwUrl}/platform/api/v1/accounts`, {
      method: 'POST',
      headers: platHeaders,
      body: JSON.stringify({ name }),
    });
    const account = await r1.json() as { id?: number };
    if (!r1.ok || !account.id) {
      console.error(`[provisioning] Chatwoot create account failed: ${r1.status} ${JSON.stringify(account)}`);
      return null;
    }
    const accountId = account.id;
    console.log(`[provisioning] Chatwoot account created: id=${accountId} name=${name}`);

    // Step 2: create admin user with the tenant's REAL email. Only if Chatwoot
    // rejects it (already in use) do we retry with a unique alias — so provisioning
    // never hard-fails, but the normal case uses the customer's real address.
    const password = generatePassword();
    const createUser = (email: string) => fetch(`${cwUrl}/platform/api/v1/users`, {
      method: 'POST',
      headers: platHeaders,
      body: JSON.stringify({ name, email, password, password_confirmation: password }),
    });

    let r2 = await createUser(realEmail);
    let user = await r2.json() as { id?: number; access_token?: string };
    let usedEmail = realEmail;
    if (!r2.ok || !user.id) {
      console.warn(`[provisioning] Chatwoot user create with real email ${realEmail} failed (${r2.status}) — retrying with alias ${aliasEmail}`);
      r2 = await createUser(aliasEmail);
      user = await r2.json() as { id?: number; access_token?: string };
      usedEmail = aliasEmail;
    }
    if (!r2.ok || !user.id) {
      console.error(`[provisioning] Chatwoot create user failed: ${r2.status} ${JSON.stringify(user)}`);
      // Roll back the orphan account we just created so it doesn't accumulate.
      await fetch(`${cwUrl}/platform/api/v1/accounts/${accountId}`, { method: 'DELETE', headers: platHeaders }).catch(() => {});
      return null;
    }
    const userId = user.id;
    const apiKey = user.access_token ?? '';
    console.log(`[provisioning] Chatwoot user created: id=${userId} email=${usedEmail} (tenant=${tenantEmail})`);

    // Step 3: add user to account as administrator
    const r3 = await fetch(`${cwUrl}/platform/api/v1/accounts/${accountId}/account_users`, {
      method: 'POST',
      headers: platHeaders,
      body: JSON.stringify({ user_id: userId, role: 'administrator' }),
    });
    if (!r3.ok) {
      console.error(`[provisioning] Chatwoot add user to account failed: ${r3.status}`);
    }

    // Step 4: get SSO login link (no password needed — customer clicks link)
    const r4 = await fetch(`${cwUrl}/platform/api/v1/users/${userId}/login`, {
      headers: platHeaders,
    });
    const sso = await r4.json() as { url?: string };
    const ssoUrl = sso.url ?? `${cwUrl}/app/login`;
    console.log(`[provisioning] Chatwoot SSO link generated for user ${userId}`);

    return { accountId, userId, apiKey, ssoUrl };
  } catch (e) {
    console.error('[provisioning] Chatwoot account creation error:', String(e));
    return null;
  }
}

async function createChatwootInbox(
  instance: string,
  name: string,
  agentId: string,
  cwAccountId: number,
  cwApiKey: string,
): Promise<number | null> {
  const webhookUrl = `${config.app.url}/webhook/chatwoot/${agentId}`;
  const cwUrl = config.chatwoot.url.replace(/\/$/, '');
  const cwHeaders = { 'Content-Type': 'application/json', 'api_access_token': cwApiKey };
  const evUrl = config.evolution.url.replace(/\/$/, '');

  // Step 1: snapshot existing inbox IDs so we can diff after creation
  let existingIds = new Set<number>();
  try {
    const listRes = await fetch(`${cwUrl}/api/v1/accounts/${cwAccountId}/inboxes`, { headers: cwHeaders });
    if (listRes.ok) {
      const { payload } = await listRes.json() as { payload: { id: number }[] };
      existingIds = new Set(payload.map(i => i.id));
    }
  } catch (e) {
    console.warn('[provisioning] Could not list existing inboxes:', String(e));
  }

  // Step 2: call Evolution /chatwoot/set — links this instance to the tenant's Chatwoot account
  // Evolution v2.3+ requires camelCase fields
  try {
    const r = await fetch(`${evUrl}/chatwoot/set/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.evolution.apiKey },
      body: JSON.stringify({
        enabled: true,
        accountId: String(cwAccountId), // Evolution requires accountId as string
        token: cwApiKey,
        url: config.chatwoot.url,
        nameInbox: name,
        signMsg: false,
        reopenConversation: true,
        conversationPending: false,
        autoCreate: true,
      }),
    });

    const rawBody = await r.text();
    console.log(`[provisioning] Evolution /chatwoot/set ${instance}: status=${r.status} body=${rawBody.slice(0, 300)}`);

    if (r.ok) {
      // autoCreate creates the inbox immediately but /chatwoot/set does NOT return inbox_id
      // Identify it by diffing the inbox list before vs after
      await new Promise(resolve => setTimeout(resolve, 1500));
      const listRes2 = await fetch(`${cwUrl}/api/v1/accounts/${cwAccountId}/inboxes`, { headers: cwHeaders });
      if (listRes2.ok) {
        const listData2 = await listRes2.json() as { payload?: { id: number; name: string }[] } | { id: number; name: string }[];
        const inboxes = Array.isArray(listData2) ? listData2 : (listData2.payload ?? []);
        const newInbox = inboxes.find(i => !existingIds.has(i.id))
          ?? inboxes.filter(i => i.name === name).sort((a, b) => b.id - a.id)[0];
        if (newInbox) {
          console.log(`[provisioning] Chatwoot inbox created: id=${newInbox.id} name=${newInbox.name}`);
          await registerChatwootWebhook(cwAccountId, cwApiKey, webhookUrl);
          return newInbox.id;
        }
      }
      console.warn('[provisioning] /chatwoot/set succeeded but could not find new inbox');
    }
  } catch (e) {
    console.error('[provisioning] Evolution /chatwoot/set error:', String(e));
  }

  console.error(`[provisioning] Failed to create Chatwoot inbox agent=${agentId} instance=${instance}`);
  return null;
}

async function registerChatwootWebhook(accountId: number, apiKey: string, webhookUrl: string): Promise<void> {
  const cwUrl = config.chatwoot.url.replace(/\/$/, '');
  try {
    const r = await fetch(`${cwUrl}/api/v1/accounts/${accountId}/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api_access_token': apiKey },
      body: JSON.stringify({
        url: webhookUrl,
        subscriptions: ['message_created', 'conversation_updated'],
      }),
    });
    const body = await r.text();
    console.log(`[provisioning] Chatwoot webhook register: status=${r.status} body=${body.slice(0, 200)}`);
  } catch (e) {
    console.error('[provisioning] Chatwoot webhook register failed:', String(e));
  }
}

// ── Repair / reprovision ─────────────────────────────────────────────────────

/** Generate a fresh Chatwoot SSO URL for a tenant. Falls back to account_users endpoint if userId not stored. */
export async function getChatwootSsoUrl(tenantId: string, accountId: number, userId?: number): Promise<string | null> {
  const cwUrl = config.chatwoot.url.replace(/\/$/, '');
  const platHeaders = { 'Content-Type': 'application/json', 'api_access_token': config.chatwoot.platformKey };

  let uid = userId;

  if (!uid) {
    // Fallback: list account users and pick the first administrator
    try {
      const r = await fetch(`${cwUrl}/platform/api/v1/accounts/${accountId}/account_users`, { headers: platHeaders });
      if (r.ok) {
        const users = await r.json() as Array<{ user_id: number; role: string }>;
        const admin = Array.isArray(users) ? users.find(u => u.role === 'administrator') ?? users[0] : null;
        uid = admin?.user_id;
        // Persist userId so future calls don't need this lookup
        if (uid) {
          try {
            const db = await getDb();
            await db.collection('tenants').updateOne(
              { _id: tenantId } as Record<string, unknown>,
              { $set: { 'chatwoot.userId': uid } },
            );
          } catch { /* non-fatal */ }
        }
      }
    } catch (e) {
      console.error('[provisioning] SSO user lookup failed:', String(e));
    }
  }

  if (!uid) return null;

  try {
    const r = await fetch(`${cwUrl}/platform/api/v1/users/${uid}/login`, { headers: platHeaders });
    if (r.ok) {
      const data = await r.json() as { url?: string };
      return data.url ?? null;
    }
    console.warn(`[provisioning] SSO login endpoint status=${r.status} for uid=${uid}`);
  } catch (e) {
    console.error('[provisioning] SSO link generation failed:', String(e));
  }
  return null;
}

/** Re-provision an existing agent: update Evolution webhook, fix Chatwoot inbox + webhook. */
export async function reprovisionAgent(agentId: string): Promise<{ ok: boolean; results: Record<string, string> }> {
  const results: Record<string, string> = {};
  const db = await getDb();

  const agent = await db.collection<AgentDoc>('agents').findOne({ _id: agentId } as Record<string, unknown>);
  if (!agent) return { ok: false, results: { error: 'Agent not found' } };

  const tenant = await db.collection<TenantDoc>('tenants').findOne({ _id: agent.tenantId });
  if (!tenant?.chatwoot) return { ok: false, results: { error: 'Tenant has no Chatwoot account' } };

  const { accountId: cwAccountId, apiKey: cwApiKey } = tenant.chatwoot;
  const instance = agent.evolutionInstance;
  const evUrl = config.evolution.url.replace(/\/$/, '');
  const evHeaders = { 'Content-Type': 'application/json', apikey: config.evolution.apiKey };
  const webhookUrl = `${config.app.url}/webhook/evolution/${instance}`;

  // 1. Update Evolution webhook to include MESSAGES_UPSERT
  try {
    await setEvolutionWebhook(instance, webhookUrl, evUrl, evHeaders);
    results.evolution_webhook = 'ok (MESSAGES_UPSERT enabled)';
  } catch (e) { results.evolution_webhook = `error: ${String(e)}`; }

  // 2. Fix Chatwoot inbox if missing
  if (!agent.chatwootInboxId) {
    const inboxId = await createChatwootInbox(instance, agent.name, agentId, cwAccountId, cwApiKey);
    if (inboxId) {
      await db.collection<AgentDoc>('agents').updateOne(
        { _id: agentId } as Record<string, unknown>,
        { $set: { chatwootInboxId: inboxId } },
      );
      results.chatwoot_inbox = `created inboxId=${inboxId}`;
    } else {
      results.chatwoot_inbox = 'failed to create/find inbox';
    }
  } else {
    results.chatwoot_inbox = `already present inboxId=${agent.chatwootInboxId}`;
  }

  // 3. Ensure Chatwoot webhook is registered
  const cwWebhookUrl = `${config.app.url}/webhook/chatwoot/${agentId}`;
  const cwUrl2 = config.chatwoot.url.replace(/\/$/, '');
  const cwHeaders = { 'Content-Type': 'application/json', 'api_access_token': cwApiKey };
  try {
    const listRes = await fetch(`${cwUrl2}/api/v1/accounts/${cwAccountId}/webhooks`, { headers: cwHeaders });
    if (listRes.ok) {
      // Chatwoot returns { payload: { webhooks: [...] } }
      const whData = await listRes.json() as {
        payload?: { webhooks?: Array<{ id: number; url: string }> } | Array<{ id: number; url: string }>;
        webhooks?: Array<{ id: number; url: string }>;
      };
      const nested = whData.payload;
      const webhooks: Array<{ id: number; url: string }> = Array.isArray(nested)
        ? nested
        : Array.isArray((nested as { webhooks?: unknown })?.webhooks)
          ? (nested as { webhooks: Array<{ id: number; url: string }> }).webhooks
          : Array.isArray(whData.webhooks) ? whData.webhooks : [];
      const existing = webhooks.find(w => w.url === cwWebhookUrl);
      if (existing) {
        results.chatwoot_webhook = `already registered id=${existing.id}`;
      } else {
        await registerChatwootWebhook(cwAccountId, cwApiKey, cwWebhookUrl);
        results.chatwoot_webhook = 'registered';
      }
    } else {
      await registerChatwootWebhook(cwAccountId, cwApiKey, cwWebhookUrl);
      results.chatwoot_webhook = 'registered (list failed, registered anyway)';
    }
  } catch (e) { results.chatwoot_webhook = `error: ${String(e)}`; }

  // 4. Re-run Chatwoot integration on Evolution (re-link instance to inbox)
  try {
    const cwSetRes = await fetch(`${evUrl}/chatwoot/set/${instance}`, {
      method: 'POST',
      headers: evHeaders,
      body: JSON.stringify({
        enabled: true,
        accountId: String(cwAccountId), // Evolution requires string
        token: cwApiKey,
        url: config.chatwoot.url,
        nameInbox: agent.name,
        signMsg: false,
        reopenConversation: true,
        conversationPending: false,
        autoCreate: true,
      }),
    });
    const cwSetBody = await cwSetRes.text();
    results.chatwoot_set = `status=${cwSetRes.status} body=${cwSetBody.slice(0, 200)}`;
  } catch (e) { results.chatwoot_set = `error: ${String(e)}`; }

  return { ok: true, results };
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

function generatePassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
  return Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
