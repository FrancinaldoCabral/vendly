import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth, requireAdmin, signTenantToken } from './auth.js';
import { config } from '../config.js';
import { checkWcSubscription, findOrCreateTenant, sendMagicLink, reprovisionAgent, getChatwootSsoUrl } from '../services/provisioning.js';
import { tenantsRouter } from './routes/tenants.js';
import { agentsRouter } from './routes/agents.js';
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
          const { payload: inboxes } = await inboxRes.json() as { payload: unknown[] };
          result.chatwoot_inboxes = inboxes;
        } else {
          result.chatwoot_inboxes_error = inboxRes.status;
        }
        if (webhookRes.ok) {
          const { payload: webhooks } = await webhookRes.json() as { payload: unknown[] };
          result.chatwoot_webhooks = webhooks;
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

// ── Admin: reset all tenant data (no JWT needed — admin key only) ─────────────
apiRouter.post('/admin/reset', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const results: Record<string, string> = {};

    // 1. Drop MongoDB vendly database
    try {
      const client = await getClient();
      await client.db('vendly').dropDatabase();
      results.mongodb = 'dropped database vendly';
    } catch (e) { results.mongodb = `error: ${String(e)}`; }

    // 2. Flush all Redis keys
    try {
      const redis = getRedis();
      await redis.flushall();
      results.redis = 'FLUSHALL ok';
    } catch (e) { results.redis = `error: ${String(e)}`; }

    // 3. Delete Qdrant agent_* collections
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
apiRouter.use('/tenants', tenantsRouter);
apiRouter.use('/agents', agentsRouter);
apiRouter.use('/knowledge', knowledgeRouter);
apiRouter.use('/scheduled_posts', scheduledPostsRouter);
apiRouter.use('/conversations', conversationsRouter);
