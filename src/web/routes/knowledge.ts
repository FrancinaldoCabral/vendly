/**
 * knowledge.ts — Knowledge base CRUD (per-agent Qdrant collections)
 * Collection: agent_{agentId}
 */
import { Router } from 'express';
import { config } from '../../config.js';
import { getDb } from '../../tools/mongodb.js';

export const knowledgeRouter = Router();

const qdrantBase = config.qdrant.url.replace(/\/$/, '');
const qdrantHeaders = () => ({
  'Content-Type': 'application/json',
  ...(config.qdrant.apiKey ? { 'api-key': config.qdrant.apiKey } : {}),
});

async function resolveCollection(agentId: string, tenantId: string): Promise<string | null> {
  if (!agentId) return null;
  const db = await getDb();
  const filter: Record<string, unknown> = { _id: agentId };
  if (tenantId !== '__admin__') filter.tenantId = tenantId;
  const agent = await db.collection('agents').findOne(filter, { projection: { _id: 1 } });
  return agent ? `agent_${agentId}` : null;
}

// GET /api/knowledge?agentId=&category=&page=&limit=
knowledgeRouter.get('/', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const agentId = String(req.query.agentId ?? '');
    const collection = await resolveCollection(agentId, tenantId);
    if (!collection) { res.status(400).json({ error: 'agentId obrigatório e válido' }); return; }

    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Number(req.query.page ?? 0) * limit;
    const filter: Record<string, unknown>[] = [{ key: 'agentId', match: { value: agentId } }];
    if (req.query.category) filter.push({ key: 'category', match: { value: String(req.query.category) } });

    const r = await fetch(`${qdrantBase}/collections/${collection}/points/scroll`, {
      method: 'POST',
      headers: qdrantHeaders(),
      body: JSON.stringify({ limit, offset, with_payload: true, with_vector: false, filter: { must: filter } }),
    });
    const data = await r.json() as { result?: { points: unknown[] } };
    res.json({ data: data.result?.points ?? [] });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST /api/knowledge — create knowledge item (auto-embeds)
knowledgeRouter.post('/', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const { title, text, category, agentId } = req.body as Record<string, string>;
    if (!title || !text || !agentId) {
      res.status(400).json({ error: 'title, text e agentId são obrigatórios' }); return;
    }
    const collection = await resolveCollection(agentId, tenantId);
    if (!collection) { res.status(404).json({ error: 'Agente não encontrado' }); return; }

    const embRes = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openrouter.apiKey}` },
      body: JSON.stringify({ model: config.openrouter.embeddingModel, input: `${title}: ${text}` }),
    });
    const embData = await embRes.json() as { data?: { embedding: number[] }[] };
    const vector = embData.data?.[0]?.embedding;
    if (!vector) { res.status(500).json({ error: 'Falha ao gerar embedding' }); return; }

    const pointId = Date.now();
    const payload = {
      title, text,
      category: category ?? 'general',
      agentId,
      tenantId,
      createdAt: new Date().toISOString(),
    };

    await fetch(`${qdrantBase}/collections/${collection}/points`, {
      method: 'PUT',
      headers: qdrantHeaders(),
      body: JSON.stringify({ points: [{ id: pointId, vector, payload }] }),
    });
    res.status(201).json({ id: pointId, payload });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// PUT /api/knowledge/:id?agentId= — update payload (no re-embedding)
knowledgeRouter.put('/:id', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const agentId = String(req.query.agentId ?? req.body.agentId ?? '');
    const collection = await resolveCollection(agentId, tenantId);
    if (!collection) { res.status(404).json({ error: 'Agente não encontrado' }); return; }

    const { title, text, category } = req.body as Record<string, string>;
    const payload: Record<string, string> = {};
    if (title) payload.title = title;
    if (text) payload.text = text;
    if (category) payload.category = category;

    await fetch(`${qdrantBase}/collections/${collection}/points/payload`, {
      method: 'POST',
      headers: qdrantHeaders(),
      body: JSON.stringify({ payload, points: [Number(req.params.id)] }),
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// DELETE /api/knowledge/:id?agentId=
knowledgeRouter.delete('/:id', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const agentId = String(req.query.agentId ?? '');
    const collection = await resolveCollection(agentId, tenantId);
    if (!collection) { res.status(404).json({ error: 'Agente não encontrado' }); return; }

    await fetch(`${qdrantBase}/collections/${collection}/points/delete`, {
      method: 'POST',
      headers: qdrantHeaders(),
      body: JSON.stringify({ points: [Number(req.params.id)] }),
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
