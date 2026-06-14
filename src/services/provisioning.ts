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

export async function provisionAgent(input: ProvisionAgentInput): Promise<AgentDoc & { qrCodeUrl: string }> {
  const db = await getDb();
  const agentId = generateId();
  const instance = `agent_${agentId}`;

  // 1. Load tenant to get their Chatwoot credentials
  const tenant = await db.collection<TenantDoc>('tenants').findOne({ _id: input.tenantId });
  if (!tenant?.chatwoot) {
    throw new Error(`Tenant ${input.tenantId} has no Chatwoot account. Call provisionTenant first.`);
  }
  const { accountId: cwAccountId, apiKey: cwApiKey } = tenant.chatwoot;

  // 2. Create Evolution instance + register webhook for connection updates
  const evolutionWebhookUrl = `${config.app.url}/webhook/evolution/${instance}`;
  await createEvolutionInstance(instance, evolutionWebhookUrl);

  // 3. Create Chatwoot inbox using tenant's own account
  const inboxId = await createChatwootInbox(instance, input.name, agentId, cwAccountId, cwApiKey);

  // 4. Create Qdrant collection
  await createQdrantCollection(agentId);

  // 5. Save agent to MongoDB
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

  const qrCodeUrl = `${config.evolution.url}/instance/qrcode/${instance}`;
  console.log(`[provisioning] Agent created: ${agentId} instance=${instance} chatwootInbox=${inboxId}`);
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

  const evUrl = config.evolution.url.replace(/\/$/, '');
  const evHeaders = { apikey: config.evolution.apiKey };

  // 1. Logout Evolution instance (graceful disconnect, ignore errors)
  try {
    const r = await fetch(`${evUrl}/instance/logout/${agent.evolutionInstance}`, {
      method: 'DELETE', headers: evHeaders,
    });
    console.log(`[provisioning] Evolution logout ${agent.evolutionInstance}: ${r.status}`);
  } catch (e) {
    console.warn(`[provisioning] Evolution logout failed (continuing):`, String(e));
  }

  // 2. Delete Evolution instance — verified: DELETE /instance/delete/{name} → 200 {"status":"SUCCESS"}
  try {
    const r = await fetch(`${evUrl}/instance/delete/${agent.evolutionInstance}`, {
      method: 'DELETE', headers: evHeaders,
    });
    const body = await r.text();
    console.log(`[provisioning] Evolution delete ${agent.evolutionInstance}: ${r.status} ${body.slice(0, 200)}`);
  } catch (e) {
    console.error(`[provisioning] Evolution delete failed:`, String(e));
  }

  // 3. Delete Chatwoot inbox using tenant's credentials
  if (agent.chatwootInboxId) {
    try {
      const tenant = await db.collection<TenantDoc>('tenants').findOne({ _id: agent.tenantId });
      if (tenant?.chatwoot) {
        const cwUrl = config.chatwoot.url.replace(/\/$/, '');
        const r = await fetch(`${cwUrl}/api/v1/accounts/${tenant.chatwoot.accountId}/inboxes/${agent.chatwootInboxId}`, {
          method: 'DELETE',
          headers: { 'api_access_token': tenant.chatwoot.apiKey },
        });
        console.log(`[provisioning] Chatwoot inbox delete ${agent.chatwootInboxId}: ${r.status}`);
      } else {
        console.warn(`[provisioning] Tenant ${agent.tenantId} has no Chatwoot account — skipping inbox delete`);
      }
    } catch (e) {
      console.error(`[provisioning] Chatwoot inbox delete failed:`, String(e));
    }
  }

  // 4. Delete Qdrant collection
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

  await db.collection<AgentDoc>('agents').deleteOne(filter);
  console.log(`[provisioning] Agent deprovisioned: ${agentId} instance=${agent.evolutionInstance} inbox=${agent.chatwootInboxId}`);
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

  // Use internal email to guarantee uniqueness — avoids conflicts when tenant's real email
  // is already registered in Chatwoot (e.g. as super admin). SSO link bypasses this email anyway.
  const internalEmail = `tenant-${tenantId}@accounts.vendly.chat`;

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

    // Step 2: create admin user with internal email (avoids conflicts with real email)
    const password = generatePassword();
    const r2 = await fetch(`${cwUrl}/platform/api/v1/users`, {
      method: 'POST',
      headers: platHeaders,
      body: JSON.stringify({ name, email: internalEmail, password, password_confirmation: password }),
    });
    const user = await r2.json() as { id?: number; access_token?: string };
    if (!r2.ok || !user.id) {
      console.error(`[provisioning] Chatwoot create user failed: ${r2.status} ${JSON.stringify(user)}`);
      return null;
    }
    const userId = user.id;
    const apiKey = user.access_token ?? '';
    console.log(`[provisioning] Chatwoot user created: id=${userId} internalEmail=${internalEmail} tenantEmail=${tenantEmail}`);

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

/** Generate a fresh Chatwoot SSO URL for a tenant. Falls back to listing platform users if userId not stored. */
export async function getChatwootSsoUrl(tenantId: string, accountId: number, userId?: number): Promise<string | null> {
  const cwUrl = config.chatwoot.url.replace(/\/$/, '');
  const platHeaders = { 'Content-Type': 'application/json', 'api_access_token': config.chatwoot.platformKey };

  let uid = userId;

  if (!uid) {
    // Fallback: find user by internal email via Platform API
    const internalEmail = `tenant-${tenantId}@accounts.vendly.chat`;
    try {
      const r = await fetch(`${cwUrl}/platform/api/v1/users?email=${encodeURIComponent(internalEmail)}`, { headers: platHeaders });
      if (r.ok) {
        const data = await r.json() as { payload?: Array<{ id: number; email: string }> } | Array<{ id: number; email: string }>;
        const users = Array.isArray(data) ? data : (data as { payload?: Array<{ id: number; email: string }> }).payload ?? [];
        const found = users.find((u: { id: number; email: string }) => u.email === internalEmail);
        uid = found?.id;
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
      const whData = await listRes.json() as { webhooks?: Array<{ id: number; url: string }> } | { payload?: Array<{ id: number; url: string }> };
      const webhooks: Array<{ id: number; url: string }> = (whData as { webhooks?: Array<{ id: number; url: string }> }).webhooks
        ?? (whData as { payload?: Array<{ id: number; url: string }> }).payload
        ?? [];
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
        accountId: cwAccountId,
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
