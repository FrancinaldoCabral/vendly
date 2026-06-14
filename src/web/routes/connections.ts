/**
 * connections.ts — WhatsApp connections (Evolution instance + Chatwoot inbox).
 * A connection belongs to the negócio (tenant) and can be shared by many agents.
 * The dashboard speaks of these simply as "WhatsApp" / "números conectados".
 */
import { Router } from 'express';
import { getDb } from '../../tools/mongodb.js';
import { provisionConnection, deprovisionConnection } from '../../services/provisioning.js';
import { config } from '../../config.js';

export const connectionsRouter = Router();

function tenantFilter(req: { auth?: { tenantId: string } }): Record<string, unknown> {
  const tenantId = req.auth!.tenantId;
  return tenantId === '__admin__' ? {} : { tenantId };
}

// GET /api/connections — list connections for current tenant (with agent counts)
connectionsRouter.get('/', async (req, res) => {
  try {
    const db = await getDb();
    const connections = await db.collection('connections').find(tenantFilter(req)).toArray();
    // attach agent counts
    const counts = await db.collection('agents').aggregate([
      { $match: tenantFilter(req) },
      { $group: { _id: '$connectionId', count: { $sum: 1 } } },
    ]).toArray();
    const countMap = new Map(counts.map(c => [String(c._id), c.count as number]));
    res.json(connections.map(c => ({ ...c, agentCount: countMap.get(String(c._id)) ?? 0 })));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST /api/connections — create + provision a new WhatsApp connection
connectionsRouter.post('/', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    if (tenantId === '__admin__' && !req.body.tenantId) {
      res.status(400).json({ error: 'tenantId required for admin' }); return;
    }
    const { name } = req.body as Record<string, unknown>;
    if (!name) { res.status(400).json({ error: 'name é obrigatório' }); return; }
    const provisioned = await provisionConnection(
      (req.body.tenantId as string | undefined) ?? tenantId,
      String(name),
    );
    const { qrCodeUrl, ...connection } = provisioned;
    res.status(201).json({ connection, qrCodeUrl });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/connections/:id
connectionsRouter.get('/:id', async (req, res) => {
  try {
    const db = await getDb();
    const filter = { _id: req.params.id, ...tenantFilter(req) } as Record<string, unknown>;
    const connection = await db.collection('connections').findOne(filter);
    if (!connection) { res.status(404).json({ error: 'Connection not found' }); return; }
    res.json(connection);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// DELETE /api/connections/:id — deprovision (also removes its agents)
connectionsRouter.delete('/:id', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const t = tenantId === '__admin__' ? (req.query.tenantId as string ?? '') : tenantId;
    await deprovisionConnection(req.params.id, t);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/connections/:id/qr — QR code for pairing
connectionsRouter.get('/:id/qr', async (req, res) => {
  try {
    const db = await getDb();
    const filter = { _id: req.params.id, ...tenantFilter(req) } as Record<string, unknown>;
    const connection = await db.collection('connections').findOne(filter, { projection: { evolutionInstance: 1 } }) as { evolutionInstance?: string } | null;
    if (!connection) { res.status(404).json({ error: 'Connection not found' }); return; }
    res.json(await fetchQr(connection.evolutionInstance!));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/connections/:id/status — connection state
connectionsRouter.get('/:id/status', async (req, res) => {
  try {
    const db = await getDb();
    const filter = { _id: req.params.id, ...tenantFilter(req) } as Record<string, unknown>;
    const connection = await db.collection('connections').findOne(filter, { projection: { evolutionInstance: 1, status: 1 } }) as { evolutionInstance?: string; status?: string } | null;
    if (!connection) { res.status(404).json({ error: 'Connection not found' }); return; }

    const r = await fetch(`${config.evolution.url.replace(/\/$/, '')}/instance/connectionState/${connection.evolutionInstance}`, {
      headers: { apikey: config.evolution.apiKey },
    });
    const data = JSON.parse(await r.text()) as { instance?: { state?: string }; state?: string; connectionStatus?: string };
    const state = data.instance?.state ?? data.state ?? data.connectionStatus ?? '';
    const connected = state === 'open';

    if (connected && connection.status === 'pending_qr') {
      await db.collection('connections').updateOne(filter, { $set: { status: 'active' } });
      // activate agents waiting on this connection too
      await db.collection('agents').updateMany(
        { connectionId: req.params.id, status: 'pending_qr' },
        { $set: { status: 'active' } },
      );
    }
    res.json({ ...data, connected, connectionStatus: connected ? 'active' : connection.status });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Normalize any Evolution response shape to { base64, code }
async function fetchQr(instance: string): Promise<{ base64: string | null; code: string | null }> {
  const evUrl = config.evolution.url.replace(/\/$/, '');
  const headers = { apikey: config.evolution.apiKey };
  function extract(data: unknown): { base64: string | null; code: string | null } {
    const d = data as Record<string, unknown>;
    if (d?.base64) return { base64: d.base64 as string, code: (d.code as string) ?? null };
    const qr = d?.qrcode as Record<string, unknown> | undefined;
    if (qr?.base64) return { base64: qr.base64 as string, code: (qr.code as string) ?? null };
    const inst = (d?.instance as Record<string, unknown> | undefined)?.qrcode as Record<string, unknown> | undefined;
    if (inst?.base64) return { base64: inst.base64 as string, code: (inst.code as string) ?? null };
    return { base64: null, code: null };
  }
  for (const path of [`/instance/connect/${instance}`, `/instance/qrcode/${instance}?image=true`]) {
    try {
      const r = await fetch(`${evUrl}${path}`, { headers });
      if (r.ok) {
        const result = extract(await r.json());
        if (result.base64) return result;
      }
    } catch { /* try next */ }
  }
  return { base64: null, code: null };
}
