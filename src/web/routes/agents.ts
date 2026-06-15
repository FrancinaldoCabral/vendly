/**
 * agents.ts — CRUD for agents (multi-tenant)
 * Provisioning (Evolution + Chatwoot + Qdrant) happens on POST.
 */
import { Router } from 'express';
import { getDb } from '../../tools/mongodb.js';
import { provisionAgent, deprovisionAgent, type ProvisionAgentInput } from '../../services/provisioning.js';
import { getRedis } from '../../tools/redis.js';
import { config } from '../../config.js';

export const agentsRouter = Router();

// ── Contact filter (blacklist / whitelist) helpers ───────────────────────────

interface ContactFilter {
  mode: 'blacklist' | 'whitelist';
  contacts: string[];
  groups: string[];
}

function sanitizeFilter(f: Partial<ContactFilter> | undefined | null): ContactFilter {
  const mode = f?.mode === 'whitelist' ? 'whitelist' : 'blacklist';
  const contacts = Array.from(new Set((f?.contacts ?? []).map(c => String(c).replace(/\D/g, '')).filter(Boolean)));
  const groups = Array.from(new Set((f?.groups ?? []).map(g => String(g).trim()).filter(g => g.endsWith('@g.us'))));
  return { mode, contacts, groups };
}

/** Mirror the filter into Redis (contact_filter:{instance}) for the webhook fast-path. */
async function syncFilterToRedis(instance: string, filter: ContactFilter): Promise<void> {
  if (!instance) return;
  try {
    await getRedis().set(`contact_filter:${instance}`, JSON.stringify(filter));
  } catch (e) {
    console.warn('[agents] syncFilterToRedis failed:', String(e));
  }
}

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
    const { name, systemPrompt, model, tools, phone, connectionId,
      builtinTools, assets, assistantName, customApis, groupConfig, contactFilter } = req.body as Record<string, unknown>;
    if (!name || !systemPrompt) {
      res.status(400).json({ error: 'name e systemPrompt são obrigatórios' }); return;
    }
    const provisioned = await provisionAgent({
      tenantId: (req.body.tenantId as string | undefined) ?? tenantId,
      name: String(name),
      systemPrompt: String(systemPrompt),
      model: model ? String(model) : undefined,
      tools: Array.isArray(tools) ? (tools as string[]) : undefined,
      builtinTools: Array.isArray(builtinTools) ? (builtinTools as string[]) : undefined,
      assets: assets as ProvisionAgentInput['assets'],
      assistantName: assistantName ? String(assistantName) : undefined,
      customApis: Array.isArray(customApis) ? (customApis as unknown[]) : undefined,
      groupConfig: groupConfig as { respondToMentions: boolean; respondToReplies: boolean; respondToAll: boolean } | undefined,
      contactFilter: contactFilter ? sanitizeFilter(contactFilter as Partial<ContactFilter>) : undefined,
      phone: phone ? String(phone) : undefined,
      connectionId: connectionId ? String(connectionId) : undefined,
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

    const allowed = ['name', 'assistantName', 'systemPrompt', 'model', 'temperature', 'maxIter', 'tools',
      'builtinTools', 'assets', 'customApis', 'groupConfig', 'contactFilter', 'priority',
      'escalationTeamId', 'escalationAgentId', 'status'];
    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of allowed) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    }
    // Sanitize the contact filter if present
    if (update.contactFilter !== undefined) {
      update.contactFilter = sanitizeFilter(update.contactFilter as Partial<ContactFilter>);
    }

    const result = await db.collection('agents').findOneAndUpdate(
      filter,
      { $set: update },
      { returnDocument: 'after' },
    );
    if (!result) { res.status(404).json({ error: 'Agent not found' }); return; }
    // Keep the Redis fast-path filter in sync with the agent's instance
    if (update.contactFilter !== undefined) {
      const inst = (result as { evolutionInstance?: string }).evolutionInstance ?? '';
      await syncFilterToRedis(inst, update.contactFilter as ContactFilter);
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/agents/:agentId/contact-filter — blacklist/whitelist for this agent
agentsRouter.get('/:agentId/contact-filter', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const db = await getDb();
    const filter: Record<string, unknown> = { _id: req.params.agentId };
    if (tenantId !== '__admin__') filter.tenantId = tenantId;
    const agent = await db.collection('agents').findOne(filter, { projection: { contactFilter: 1 } }) as { contactFilter?: Partial<ContactFilter> } | null;
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    res.json({ contactFilter: sanitizeFilter(agent.contactFilter) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// PUT /api/agents/:agentId/contact-filter — replace blacklist/whitelist
agentsRouter.put('/:agentId/contact-filter', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const db = await getDb();
    const filter: Record<string, unknown> = { _id: req.params.agentId };
    if (tenantId !== '__admin__') filter.tenantId = tenantId;
    const clean = sanitizeFilter(req.body as Partial<ContactFilter>);
    const result = await db.collection('agents').findOneAndUpdate(
      filter,
      { $set: { contactFilter: clean, updatedAt: new Date() } },
      { returnDocument: 'after', projection: { evolutionInstance: 1, contactFilter: 1 } },
    ) as { evolutionInstance?: string } | null;
    if (!result) { res.status(404).json({ error: 'Agent not found' }); return; }
    await syncFilterToRedis(result.evolutionInstance ?? '', clean);
    res.json({ contactFilter: clean });
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

// GET /api/agents/:agentId/qr — returns QR code for Evolution instance
agentsRouter.get('/:agentId/qr', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const db = await getDb();
    const filter: Record<string, unknown> = { _id: req.params.agentId };
    if (tenantId !== '__admin__') filter.tenantId = tenantId;
    const agent = await db.collection('agents').findOne(filter, { projection: { evolutionInstance: 1 } }) as { evolutionInstance?: string } | null;
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

    const instance = agent.evolutionInstance;
    const evUrl = config.evolution.url.replace(/\/$/, '');
    const headers = { apikey: config.evolution.apiKey };

    // Normalize any Evolution response shape to { base64, code }
    function extractQr(data: unknown): { base64: string | null; code: string | null } {
      const d = data as Record<string, unknown>;
      // flat: { base64, code }
      if (d?.base64) return { base64: d.base64 as string, code: (d.code as string) ?? null };
      // wrapped: { qrcode: { base64, code } }
      const qr = d?.qrcode as Record<string, unknown> | undefined;
      if (qr?.base64) return { base64: qr.base64 as string, code: (qr.code as string) ?? null };
      // deep: { instance: { qrcode: { base64, code } } }
      const inst = (d?.instance as Record<string, unknown> | undefined)?.qrcode as Record<string, unknown> | undefined;
      if (inst?.base64) return { base64: inst.base64 as string, code: (inst.code as string) ?? null };
      return { base64: null, code: null };
    }

    // Try /instance/connect/{name} first — returns fresh QR in Evolution v2
    try {
      const r = await fetch(`${evUrl}/instance/connect/${instance}`, { headers });
      if (r.ok) {
        const result = extractQr(await r.json());
        if (result.base64) { res.json(result); return; }
      }
    } catch { /* fallthrough */ }

    // Fallback: /instance/qrcode/{name}?image=true — works on most versions
    try {
      const r2 = await fetch(`${evUrl}/instance/qrcode/${instance}?image=true`, { headers });
      if (r2.ok) {
        const result = extractQr(await r2.json());
        if (result.base64) { res.json(result); return; }
      }
    } catch { /* fallthrough */ }

    res.json({ base64: null, code: null });
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

    const r = await fetch(`${config.evolution.url.replace(/\/$/, '')}/instance/connectionState/${agent.evolutionInstance}`, {
      headers: { apikey: config.evolution.apiKey },
    });
    // Evolution returns different formats depending on version:
    // v2: { instance: { state: 'open' } }
    // some builds: { state: 'open' }
    // some builds: { connectionStatus: 'open' }
    const rawState = await r.text();
    console.log(`[agents/status] ${agent.evolutionInstance}: ${rawState.slice(0, 200)}`);
    const data = JSON.parse(rawState) as {
      instance?: { state?: string };
      state?: string;
      connectionStatus?: string;
    };
    const state = data.instance?.state ?? data.state ?? data.connectionStatus ?? '';
    const connected = state === 'open';

    // Auto-update agent status when connected (fallback if webhook missed)
    let agentStatus = agent.status ?? '';
    if (connected && agentStatus === 'pending_qr') {
      await db.collection('agents').updateOne(filter, { $set: { status: 'active' } });
      agentStatus = 'active';
    }

    res.json({ ...data, agentStatus, connected });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
