import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth, requireAdmin, signTenantToken } from './auth.js';
import { config } from '../config.js';
import { checkWcSubscription, findOrCreateTenant, sendMagicLink, reprovisionAgent, getChatwootSsoUrl } from '../services/provisioning.js';
import { tenantsRouter } from './routes/tenants.js';
import { agentsRouter } from './routes/agents.js';
import { connectionsRouter } from './routes/connections.js';
import { TOOL_CATALOG } from '../services/tool-catalog.js';
import { uploadFile } from '../services/storage.js';
import { knowledgeRouter } from './routes/knowledge.js';
import { scheduledPostsRouter } from './routes/scheduled_posts.js';
import { conversationsRouter } from './routes/conversations.js';
import { getClient, getDb } from '../tools/mongodb.js';
import { getRedis } from '../tools/redis.js';

export const apiRouter = Router();

// Public: WordPress-based login (email + password → Vendly session JWT)
apiRouter.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      res.status(400).json({ error: 'Email e senha são obrigatórios' });
      return;
    }

    const wpUrl = config.wordpress.url;
    if (!wpUrl) {
      res.status(503).json({ error: 'Autenticação WordPress não configurada' });
      return;
    }

    // 1. Authenticate against WordPress JWT Auth plugin
    const wpRes = await fetch(`${wpUrl.replace(/\/$/, '')}/wp-json/jwt-auth/v1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: email.trim(), password }),
    });

    if (!wpRes.ok) {
      res.status(401).json({ error: 'Email ou senha incorretos' });
      return;
    }

    type WpTokenResponse = { token: string; user_email: string; user_display_name?: string };
    const wpData = await wpRes.json() as WpTokenResponse;
    const userEmail = (wpData.user_email ?? email).trim().toLowerCase();

    // 2. Check WooCommerce subscription
    const wc = await checkWcSubscription(userEmail);
    if (!wc.hasAccess) {
      res.status(403).json({ error: 'Nenhuma assinatura ativa encontrada para este email.' });
      return;
    }

    // 3. Find or create tenant
    const { tenant } = await findOrCreateTenant(userEmail, {
      wcUserId: wc.wcUserId,
      wcUserName: wc.wcUserName ?? wpData.user_display_name,
    });

    if (tenant.status === 'suspended') {
      res.status(403).json({ error: 'Conta suspensa. Entre em contato com o suporte.' });
      return;
    }

    // 4. Issue Vendly session JWT
    const sessionToken = signTenantToken(tenant._id, tenant.email);
    res.json({ token: sessionToken });
  } catch (e) {
    console.error('[auth/login]', String(e));
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// Public: request a magic link (validates WooCommerce subscription)
apiRouter.post('/auth/request-link', async (req, res) => {
  try {
    const { email } = req.body as { email?: string };
    if (!email || !email.includes('@')) {
      res.status(400).json({ error: 'Email inválido' });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Check WooCommerce subscription
    const wc = await checkWcSubscription(normalizedEmail);
    if (!wc.hasAccess) {
      res.status(403).json({ error: 'Nenhuma assinatura ativa encontrada para este email.' });
      return;
    }

    // Find or auto-create tenant
    const { tenant } = await findOrCreateTenant(normalizedEmail, {
      wcUserId: wc.wcUserId,
      wcUserName: wc.wcUserName,
    });

    if (tenant.status === 'suspended') {
      res.status(403).json({ error: 'Conta suspensa. Entre em contato com o suporte.' });
      return;
    }

    // Send magic link
    await sendMagicLink(normalizedEmail, tenant._id, tenant.name);

    res.json({ ok: true });
  } catch (e) {
    console.error('[auth/request-link]', String(e));
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// Public: exchange magic-link JWT for session token
apiRouter.post('/auth/token', async (req, res) => {
  try {
    const { token } = req.body as { token?: string };
    if (!token) { res.status(400).json({ error: 'token obrigatório' }); return; }
    const payload = jwt.verify(token, config.jwt.secret) as { tenantId: string; email: string };
    const sessionToken = signTenantToken(payload.tenantId, payload.email);
    res.json({ token: sessionToken, tenantId: payload.tenantId });

    // Non-blocking: heal Chatwoot account if this is a WooCommerce-provisioned tenant without one
    findOrCreateTenant(payload.email).catch(e => {
      console.warn('[auth/token] Chatwoot heal failed (non-fatal):', String(e));
    });
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado' });
  }
});

// ── Admin: diagnose Chatwoot Platform API from server ────────────────────────
apiRouter.post('/admin/diag-chatwoot', requireAuth, requireAdmin, async (_req, res) => {
  const cwUrl = config.chatwoot.url.replace(/\/$/, '');
  const platKey = config.chatwoot.platformKey;
  const steps: Record<string, unknown> = { cwUrl, hasPlatKey: !!platKey };

  // Step 1: create test account
  try {
    const r1 = await fetch(`${cwUrl}/platform/api/v1/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api_access_token': platKey },
      body: JSON.stringify({ name: '__diag_test__' }),
    });
    const body1 = await r1.text();
    steps.step1_status = r1.status;
    steps.step1_body = body1.slice(0, 500);

    if (r1.ok) {
      const account = JSON.parse(body1) as { id?: number };
      const accountId = account.id;
      steps.step1_accountId = accountId;

      // Step 2: create test user
      const r2 = await fetch(`${cwUrl}/platform/api/v1/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api_access_token': platKey },
        body: JSON.stringify({ name: 'DiagTest', email: `diag-${Date.now()}@test.vendly.chat`, password: 'Diag1234!', password_confirmation: 'Diag1234!' }),
      });
      const body2 = await r2.text();
      steps.step2_status = r2.status;
      steps.step2_body = body2.slice(0, 500);

      // Cleanup: delete the test account
      if (accountId) {
        await fetch(`${cwUrl}/platform/api/v1/accounts/${accountId}`, {
          method: 'DELETE',
          headers: { 'api_access_token': platKey },
        });
        steps.cleanup = `deleted account ${accountId}`;
      }
    }
  } catch (e) {
    steps.error = String(e);
  }

  res.json(steps);
});

// ── Admin: full state diagnostic for a tenant ─────────────────────────────────
apiRouter.get('/admin/tenant-state', requireAuth, requireAdmin, async (req, res) => {
  const email = req.query.email as string | undefined;
  if (!email) { res.status(400).json({ error: 'email query param required' }); return; }

  try {
    const db = await getDb();
    const tenant = await db.collection('tenants').findOne({ email });
    if (!tenant) { res.status(404).json({ error: 'Tenant not found' }); return; }

    const agents = await db.collection('agents').find({ tenantId: tenant._id }).toArray();
    const result: Record<string, unknown> = { tenant, agents };

    // Generate fresh Chatwoot SSO URL
    if (tenant.chatwoot?.accountId) {
      const ssoUrl = await getChatwootSsoUrl(String(tenant._id), tenant.chatwoot.accountId, tenant.chatwoot.userId);
      result.chatwoot_sso = ssoUrl ?? 'failed to generate';
    }

    // List Chatwoot inboxes + webhooks for tenant's account
    if (tenant.chatwoot?.accountId && tenant.chatwoot?.apiKey) {
      const cwUrl = (process.env.CHATWOOT_URL ?? '').replace(/\/$/, '');
      const cwHeaders = { 'api_access_token': tenant.chatwoot.apiKey };
      try {
        const [inboxRes, webhookRes] = await Promise.all([
          fetch(`${cwUrl}/api/v1/accounts/${tenant.chatwoot.accountId}/inboxes`, { headers: cwHeaders }),
          fetch(`${cwUrl}/api/v1/accounts/${tenant.chatwoot.accountId}/webhooks`, { headers: cwHeaders }),
        ]);
        if (inboxRes.ok) {
          const inboxData = await inboxRes.json() as { payload?: unknown[] } | unknown[];
          result.chatwoot_inboxes = Array.isArray(inboxData) ? inboxData : (inboxData as { payload?: unknown[] }).payload ?? inboxData;
        } else {
          result.chatwoot_inboxes_error = inboxRes.status;
        }
        if (webhookRes.ok) {
          const whData = await webhookRes.json() as { webhooks?: unknown[] } | { payload?: unknown[] };
          result.chatwoot_webhooks = (whData as { webhooks?: unknown[] }).webhooks
            ?? (whData as { payload?: unknown[] }).payload
            ?? whData;
        } else {
          result.chatwoot_webhooks_error = webhookRes.status;
        }
      } catch (e) { result.chatwoot_api_error = String(e); }
    }

    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Admin: repair an agent's Evolution webhook + Chatwoot inbox ───────────────
apiRouter.post('/admin/fix-agent', requireAuth, requireAdmin, async (req, res) => {
  const { agentId, tenantId } = req.body as { agentId?: string; tenantId?: string };

  if (!agentId && !tenantId) {
    res.status(400).json({ error: 'agentId or tenantId required' });
    return;
  }

  try {
    const db = await getDb();
    const agentIds: string[] = [];

    if (agentId) {
      agentIds.push(agentId);
    } else {
      // Repair all agents for tenant
      const agents = await db.collection('agents').find({ tenantId }).toArray();
      agentIds.push(...agents.map(a => String(a._id)));
    }

    if (agentIds.length === 0) {
      res.status(404).json({ error: 'No agents found' });
      return;
    }

    const allResults: Record<string, unknown> = {};
    for (const id of agentIds) {
      allResults[id] = await reprovisionAgent(id);
    }

    res.json({ ok: true, repaired: agentIds.length, results: allResults });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Admin: seed example integrations (custom APIs) so the client can see/test them ──
// Demonstrates the three body modes against reliable public endpoints:
//  - GET with a URL placeholder (consultar_cep → viacep)
//  - POST with a STATIC body (registrar_atendimento → httpbin echoes it back)
//  - POST with a MIXED body (enviar_para_fluxo → agent fills {nome}/{mensagem})
const EXAMPLE_INTEGRATIONS = [
  {
    name: 'consultar_cep',
    description: 'Consulta o endereço a partir de um CEP que o cliente informar.',
    url: 'https://viacep.com.br/ws/{cep}/json/',
    method: 'GET',
    headers: [] as { key: string; value: string }[],
    schema: { type: 'object', required: ['cep'], properties: { cep: { type: 'string', description: 'CEP só com números, ex.: 01001000' } } },
    bodyTemplate: '',
    kind: 'responding' as const,
  },
  {
    name: 'registrar_atendimento',
    description: 'Registra que um novo atendimento começou. Corpo FIXO — o agente não preenche nada, só dispara.',
    url: 'https://httpbin.org/post',
    method: 'POST',
    headers: [{ key: 'X-Origem', value: 'vendly' }],
    schema: {},
    bodyTemplate: '{"tipo":"novo_atendimento","origem":"whatsapp"}',
    kind: 'responding' as const,
  },
  {
    name: 'enviar_para_fluxo',
    description: 'Envia o nome do cliente e um resumo do pedido para um fluxo externo. Corpo MISTO — o agente preenche nome e mensagem.',
    url: 'https://httpbin.org/post',
    method: 'POST',
    headers: [{ key: 'X-Origem', value: 'vendly' }],
    schema: { type: 'object', required: ['nome', 'mensagem'], properties: {
      nome: { type: 'string', description: 'Nome do cliente' },
      mensagem: { type: 'string', description: 'Resumo do que o cliente quer' },
    } },
    bodyTemplate: '{"nome":"{nome}","mensagem":"{mensagem}"}',
    kind: 'responding' as const,
  },
];

apiRouter.post('/admin/seed-integrations', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { email, agentId, replace } = req.body as { email?: string; agentId?: string; replace?: boolean };
    const db = await getDb();

    const filter: Record<string, unknown> = {};
    if (agentId) filter._id = agentId;
    if (email) {
      const tenant = await db.collection('tenants').findOne({ email });
      if (!tenant) { res.status(404).json({ error: `tenant not found for ${email}` }); return; }
      filter.tenantId = tenant._id;
    }

    const agents = await db.collection('agents').find(filter).toArray();
    if (agents.length === 0) { res.status(404).json({ error: 'no agents matched' }); return; }

    const updated: Array<{ agentId: string; name: string; integrations: number }> = [];
    for (const a of agents) {
      const existing = replace ? [] : (Array.isArray(a.customApis) ? a.customApis as Array<{ name: string }> : []);
      const have = new Set(existing.map(c => c.name));
      const merged = [...existing, ...EXAMPLE_INTEGRATIONS.filter(e => !have.has(e.name))];
      await db.collection('agents').updateOne(
        { _id: a._id } as Record<string, unknown>,
        { $set: { customApis: merged, updatedAt: new Date() } },
      );
      updated.push({ agentId: String(a._id), name: String(a.name ?? ''), integrations: merged.length });
    }

    res.json({ ok: true, seeded: EXAMPLE_INTEGRATIONS.map(e => e.name), agents: updated });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Admin: reset all tenant data (no JWT needed — admin key only) ─────────────
apiRouter.post('/admin/reset', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const results: Record<string, string> = {};
    const evUrl = config.evolution.url.replace(/\/$/, '');
    const evHeaders = { apikey: config.evolution.apiKey };

    // 0. Collect Chatwoot account + user IDs from MongoDB BEFORE dropping it, so we
    //    can delete both (deleting only the account leaves the user — which keeps the
    //    real email "taken" and forces the alias fallback next time).
    let chatwootAccountIds: number[] = [];
    let chatwootUserIds: number[] = [];
    try {
      const db = await getDb();
      const tenants = await db.collection('tenants').find({}, { projection: { 'chatwoot.accountId': 1, 'chatwoot.userId': 1 } }).toArray();
      chatwootAccountIds = tenants
        .map(t => (t as { chatwoot?: { accountId?: number } }).chatwoot?.accountId)
        .filter((id): id is number => typeof id === 'number');
      chatwootUserIds = tenants
        .map(t => (t as { chatwoot?: { userId?: number } }).chatwoot?.userId)
        .filter((id): id is number => typeof id === 'number');
    } catch (e) { results.chatwoot_list = `warn: ${String(e)}`; }

    // 1. Delete EVERY Evolution instance — list directly from Evolution so orphaned
    //    instances (not present in Mongo) are cleaned too. This was the bug that left
    //    a connected WhatsApp with no dashboard entry.
    let instanceNames: string[] = [];
    try {
      const r = await fetch(`${evUrl}/instance/fetchInstances`, { headers: evHeaders });
      if (r.ok) {
        const list = await r.json() as Array<{ name?: string; instance?: { instanceName?: string } }>;
        instanceNames = list.map(i => i.name ?? i.instance?.instanceName ?? '').filter(Boolean);
      }
    } catch (e) { results.evolution_list = `warn: ${String(e)}`; }

    const evDeleted: string[] = [];
    const evFailed: string[] = [];
    for (const inst of instanceNames) {
      const enc = encodeURIComponent(inst);
      try {
        await fetch(`${evUrl}/instance/logout/${enc}`, { method: 'DELETE', headers: evHeaders });
        const d = await fetch(`${evUrl}/instance/delete/${enc}`, { method: 'DELETE', headers: evHeaders });
        if (d.ok) evDeleted.push(inst); else evFailed.push(inst);
      } catch { evFailed.push(inst); }
    }
    results.evolution = instanceNames.length
      ? `deleted: ${evDeleted.join(', ') || '—'}${evFailed.length ? ` | failed: ${evFailed.join(', ')}` : ''}`
      : 'no instances';

    // 2. Delete Chatwoot accounts (removes their conversations) AND users (frees emails)
    const cwUrl = config.chatwoot.url.replace(/\/$/, '');
    const cwPlatHeaders = { 'api_access_token': config.chatwoot.platformKey };
    const cwDeleted: number[] = [];
    const cwUsersDeleted: number[] = [];
    if (config.chatwoot.platformKey) {
      for (const id of chatwootAccountIds) {
        try {
          const r = await fetch(`${cwUrl}/platform/api/v1/accounts/${id}`, { method: 'DELETE', headers: cwPlatHeaders });
          if (r.ok) cwDeleted.push(id);
        } catch { /* ignore */ }
      }
      for (const id of chatwootUserIds) {
        try {
          const r = await fetch(`${cwUrl}/platform/api/v1/users/${id}`, { method: 'DELETE', headers: cwPlatHeaders });
          if (r.ok) cwUsersDeleted.push(id);
        } catch { /* ignore */ }
      }
    }
    results.chatwoot = chatwootAccountIds.length || chatwootUserIds.length
      ? `accounts: ${cwDeleted.join(', ') || '—'} | users: ${cwUsersDeleted.join(', ') || '—'}`
      : 'no accounts';

    // 3. Drop MongoDB vendly database
    try {
      const client = await getClient();
      await client.db('vendly').dropDatabase();
      results.mongodb = 'dropped database vendly';
    } catch (e) { results.mongodb = `error: ${String(e)}`; }

    // 3. Flush all Redis keys
    try {
      const redis = getRedis();
      await redis.flushall();
      results.redis = 'FLUSHALL ok';
    } catch (e) { results.redis = `error: ${String(e)}`; }

    // 4. Delete Qdrant agent_* collections
    const qdrantBase = config.qdrant.url.replace(/\/$/, '');
    const qHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.qdrant.apiKey) qHeaders['api-key'] = config.qdrant.apiKey;
    try {
      const listRes = await fetch(`${qdrantBase}/collections`, { headers: qHeaders });
      if (listRes.ok) {
        const { result } = await listRes.json() as { result: { collections: { name: string }[] } };
        const agentCols = result.collections.filter(c => c.name.startsWith('agent_'));
        const deleted: string[] = [];
        for (const col of agentCols) {
          const d = await fetch(`${qdrantBase}/collections/${col.name}`, { method: 'DELETE', headers: qHeaders });
          if (d.ok) deleted.push(col.name);
        }
        results.qdrant = deleted.length ? `deleted: ${deleted.join(', ')}` : 'no agent_* collections';
      } else {
        results.qdrant = `list failed: ${listRes.status}`;
      }
    } catch (e) { results.qdrant = `error: ${String(e)}`; }

    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// All routes below require auth
apiRouter.use(requireAuth);
// Friendly built-in tool catalog (for the agent config UI — no technical jargon)
apiRouter.get('/tool-catalog', (_req, res) => {
  res.json(TOOL_CATALOG);
});

// Upload a file to object storage (MinIO). Body: { filename, contentType, dataBase64 }.
apiRouter.post('/uploads', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const { filename, contentType, dataBase64 } = req.body as { filename?: string; contentType?: string; dataBase64?: string };
    if (!dataBase64) { res.status(400).json({ error: 'arquivo ausente' }); return; }
    const data = Buffer.from(dataBase64, 'base64');
    if (data.length > 25 * 1024 * 1024) { res.status(413).json({ error: 'arquivo muito grande (máx. 25 MB)' }); return; }
    const url = await uploadFile(tenantId === '__admin__' ? 'admin' : tenantId, filename ?? 'arquivo', contentType ?? '', data);
    res.json({ url });
  } catch (e) { res.status(500).json({ error: String(e instanceof Error ? e.message : e) }); }
});

apiRouter.use('/tenants', tenantsRouter);
apiRouter.use('/connections', connectionsRouter);
apiRouter.use('/agents', agentsRouter);
apiRouter.use('/knowledge', knowledgeRouter);
apiRouter.use('/scheduled_posts', scheduledPostsRouter);
apiRouter.use('/conversations', conversationsRouter);
