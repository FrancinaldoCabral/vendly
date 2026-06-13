/**
 * tenants.ts — Tenant management (admin-only + tenant self-service)
 */
import { Router } from 'express';
import { getDb } from '../../tools/mongodb.js';
import { provisionTenant, type TenantDoc } from '../../services/provisioning.js';
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

// POST /api/tenants — admin: manually create tenant
tenantsRouter.post('/', requireAdmin, async (req, res) => {
  try {
    const { email, name, plan } = req.body as Record<string, string>;
    if (!email || !name) { res.status(400).json({ error: 'email e name são obrigatórios' }); return; }
    const tenant = await provisionTenant({ email, name, plan });
    res.status(201).json(tenant);
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
