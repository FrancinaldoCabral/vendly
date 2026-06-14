/**
 * agents.ts — CRUD for agents (multi-tenant)
 * Provisioning (Evolution + Chatwoot + Qdrant) happens on POST.
 */
import { Router } from 'express';
import { getDb } from '../../tools/mongodb.js';
import { provisionAgent, deprovisionAgent } from '../../services/provisioning.js';
import { config } from '../../config.js';

export const agentsRouter = Router();

// GET /api/agents — list agents for current tenant
agentsRouter.get('/', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const db = await getDb();
    const filter = tenantId === '__admin__' ? {} : { tenantId };
    const agents = await db.collection('agents').find(filter, {
      projection: { systemPrompt: 0 },
    }).toArray();
    res.json(agents);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/agents/:agentId
agentsRouter.get('/:agentId', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const db = await getDb();
    const filter: Record<string, unknown> = { _id: req.params.agentId };
    if (tenantId !== '__admin__') filter.tenantId = tenantId;
    const agent = await db.collection('agents').findOne(filter);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    res.json(agent);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST /api/agents — create + provision new agent
agentsRouter.post('/', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    if (tenantId === '__admin__' && !req.body.tenantId) {
      res.status(400).json({ error: 'tenantId required for admin' }); return;
    }
    const { name, systemPrompt, model, tools, phone } = req.body as Record<string, unknown>;
    if (!name || !systemPrompt) {
      res.status(400).json({ error: 'name e systemPrompt são obrigatórios' }); return;
    }
    const provisioned = await provisionAgent({
      tenantId: (req.body.tenantId as string | undefined) ?? tenantId,
      name: String(name),
      systemPrompt: String(systemPrompt),
      model: model ? String(model) : undefined,
      tools: Array.isArray(tools) ? (tools as string[]) : undefined,
      phone: phone ? String(phone) : undefined,
    });
    const { qrCodeUrl, ...agent } = provisioned;
    res.status(201).json({ agent, qrCodeUrl });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// PUT /api/agents/:agentId — update agent config
agentsRouter.put('/:agentId', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const db = await getDb();
    const filter: Record<string, unknown> = { _id: req.params.agentId };
    if (tenantId !== '__admin__') filter.tenantId = tenantId;

    const allowed = ['name', 'systemPrompt', 'model', 'temperature', 'maxIter', 'tools',
      'customApis', 'groupConfig', 'escalationTeamId', 'escalationAgentId', 'status'];
    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of allowed) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    }

    const result = await db.collection('agents').findOneAndUpdate(
      filter,
      { $set: update },
      { returnDocument: 'after' },
    );
    if (!result) { res.status(404).json({ error: 'Agent not found' }); return; }
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// DELETE /api/agents/:agentId — deprovision + delete
agentsRouter.delete('/:agentId', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const t = tenantId === '__admin__' ? (req.query.tenantId as string ?? '') : tenantId;
    await deprovisionAgent(req.params.agentId, t);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/agents/:agentId/qr — returns QR code URL for Evolution
agentsRouter.get('/:agentId/qr', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const db = await getDb();
    const filter: Record<string, unknown> = { _id: req.params.agentId };
    if (tenantId !== '__admin__') filter.tenantId = tenantId;
    const agent = await db.collection('agents').findOne(filter, { projection: { evolutionInstance: 1 } }) as { evolutionInstance?: string } | null;
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

    const instance = agent.evolutionInstance;
    const qrUrl = `${config.evolution.url}/instance/qrcode/${instance}`;
    // Proxy the QR from Evolution
    const r = await fetch(qrUrl, { headers: { apikey: config.evolution.apiKey } });
    if (!r.ok) { res.status(502).json({ error: `Evolution QR fetch failed: ${r.status}` }); return; }
    const data = await r.json();
    res.json(data);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/agents/:agentId/status — Evolution instance connection status
agentsRouter.get('/:agentId/status', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const db = await getDb();
    const filter: Record<string, unknown> = { _id: req.params.agentId };
    if (tenantId !== '__admin__') filter.tenantId = tenantId;
    const agent = await db.collection('agents').findOne(filter, { projection: { evolutionInstance: 1, status: 1 } }) as { evolutionInstance?: string; status?: string } | null;
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

    const r = await fetch(`${config.evolution.url}/instance/connectionState/${agent.evolutionInstance}`, {
      headers: { apikey: config.evolution.apiKey },
    });
    const data = await r.json() as { instance?: { state?: string } };
    const connected = data.instance?.state === 'open';

    // Auto-update agent status when connected
    if (connected && agent.status === 'pending_qr') {
      await db.collection('agents').updateOne(filter, { $set: { status: 'active' } });
    }

    res.json({ ...data, agentStatus: agent.status, connected });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
