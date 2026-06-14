/**
 * tenants.ts — Tenant management (admin-only + tenant self-service)
 */
import { Router } from 'express';
import { getDb } from '../../tools/mongodb.js';
import { findOrCreateTenant, sendWelcomeEmailWithChatwoot, getChatwootSsoUrl, type TenantDoc } from '../../services/provisioning.js';
import { requireAdmin } from '../auth.js';

export const tenantsRouter = Router();

// GET /api/tenants — admin: list all; tenant: own record
tenantsRouter.get('/', async (req, res) => {
  try {
    const db = await getDb();
    if (req.auth!.isAdmin) {
      const tenants = await db.collection<TenantDoc>('tenants').find({}).toArray();
      res.json(tenants);
    } else {
      const tenant = await db.collection<TenantDoc>('tenants').findOne({ _id: req.auth!.tenantId });
      if (!tenant) { res.status(404).json({ error: 'Tenant not found' }); return; }
      res.json(tenant);
    }
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST /api/tenants — admin: manually create tenant + Chatwoot account + send welcome email
tenantsRouter.post('/', requireAdmin, async (req, res) => {
  try {
    const { email, name } = req.body as Record<string, string>;
    if (!email || !name) { res.status(400).json({ error: 'email e name são obrigatórios' }); return; }
    const { tenant, isNew, chatwootSsoUrl } = await findOrCreateTenant(email, { wcUserName: name });
    if (isNew && chatwootSsoUrl) {
      await sendWelcomeEmailWithChatwoot(email, name, tenant._id, chatwootSsoUrl);
    }
    res.status(isNew ? 201 : 200).json(tenant);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// PUT /api/tenants/me — self-service: current tenant can update own name
tenantsRouter.put('/me', async (req, res) => {
  try {
    const db = await getDb();
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (req.body.name !== undefined) update.name = req.body.name;
    const result = await db.collection<TenantDoc>('tenants').findOneAndUpdate(
      { _id: req.auth!.tenantId },
      { $set: update },
      { returnDocument: 'after' },
    );
    if (!result) { res.status(404).json({ error: 'Tenant not found' }); return; }
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// PUT /api/tenants/:tenantId — admin: update status/plan
tenantsRouter.put('/:tenantId', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const allowed = ['status', 'plan', 'name'];
    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of allowed) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    }
    const result = await db.collection<TenantDoc>('tenants').findOneAndUpdate(
      { _id: req.params.tenantId },
      { $set: update },
      { returnDocument: 'after' },
    );
    if (!result) { res.status(404).json({ error: 'Tenant not found' }); return; }
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/tenants/me — current tenant profile
tenantsRouter.get('/me', async (req, res) => {
  try {
    const db = await getDb();
    const tenant = await db.collection<TenantDoc>('tenants').findOne({ _id: req.auth!.tenantId });
    if (!tenant) { res.status(404).json({ error: 'Tenant not found' }); return; }
    res.json(tenant);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/tenants/me/chatwoot-sso — generate fresh Chatwoot SSO login URL
tenantsRouter.get('/me/chatwoot-sso', async (req, res) => {
  try {
    const db = await getDb();
    const tenant = await db.collection<TenantDoc>('tenants').findOne({ _id: req.auth!.tenantId });
    if (!tenant) { res.status(404).json({ error: 'Tenant not found' }); return; }
    if (!tenant.chatwoot?.accountId) {
      res.status(404).json({ error: 'Conta Chatwoot não configurada para este tenant' });
      return;
    }

    const ssoUrl = await getChatwootSsoUrl(tenant._id, tenant.chatwoot.accountId, tenant.chatwoot.userId);
    if (!ssoUrl) {
      res.status(500).json({ error: 'Falha ao gerar link de acesso ao CRM. Tente novamente.' });
      return;
    }

    // Update stored SSO URL for future reference
    await db.collection<TenantDoc>('tenants').updateOne(
      { _id: tenant._id },
      { $set: { 'chatwoot.ssoUrl': ssoUrl } },
    );

    res.json({ url: ssoUrl });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
