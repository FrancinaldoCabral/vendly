/**
 * scheduled_posts.ts — CRUD for scheduled posts
 * Each post has: schedule (days + time), pipeline[], targets[], status
 */
import { Router } from 'express';
import { getDb } from '../../tools/mongodb.js';
import { schedulePost, stopPost, reloadPost } from '../../services/scheduler.js';

export const scheduledPostsRouter = Router();

// GET /api/scheduled_posts?agentId=
scheduledPostsRouter.get('/', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const db = await getDb();
    const filter: Record<string, unknown> = {};
    if (tenantId !== '__admin__') filter.tenantId = tenantId;
    if (req.query.agentId) filter.agentId = String(req.query.agentId);
    const posts = await db.collection('scheduled_posts').find(filter).toArray();
    res.json(posts);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/scheduled_posts/:id
scheduledPostsRouter.get('/:id', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const db = await getDb();
    const filter: Record<string, unknown> = { _id: req.params.id };
    if (tenantId !== '__admin__') filter.tenantId = tenantId;
    const post = await db.collection('scheduled_posts').findOne(filter);
    if (!post) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(post);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST /api/scheduled_posts
scheduledPostsRouter.post('/', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const { agentId, schedule, pipeline, targets } = req.body as Record<string, unknown>;
    if (!agentId || !schedule || !targets) {
      res.status(400).json({ error: 'agentId, schedule e targets são obrigatórios' }); return;
    }

    // Validate agent belongs to tenant
    const db = await getDb();
    const agentFilter: Record<string, unknown> = { _id: agentId };
    if (tenantId !== '__admin__') agentFilter.tenantId = tenantId;
    const agent = await db.collection('agents').findOne(agentFilter, { projection: { _id: 1 } });
    if (!agent) { res.status(404).json({ error: 'Agente não encontrado' }); return; }

    const postId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const doc = {
      _id: postId,
      agentId: String(agentId),
      tenantId,
      schedule,
      pipeline: Array.isArray(pipeline) ? pipeline : [],
      targets,
      status: 'active',
      createdAt: new Date(),
    };

    await db.collection('scheduled_posts').insertOne(doc as unknown as Record<string, unknown>);
    // Start cron for this post
    schedulePost(doc as unknown as Parameters<typeof schedulePost>[0]);
    res.status(201).json(doc);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// PUT /api/scheduled_posts/:id
scheduledPostsRouter.put('/:id', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const db = await getDb();
    const filter: Record<string, unknown> = { _id: req.params.id };
    if (tenantId !== '__admin__') filter.tenantId = tenantId;

    const allowed = ['schedule', 'pipeline', 'targets', 'status'];
    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of allowed) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    }

    const result = await db.collection('scheduled_posts').findOneAndUpdate(
      filter,
      { $set: update },
      { returnDocument: 'after' },
    );
    if (!result) { res.status(404).json({ error: 'Not found' }); return; }
    await reloadPost(req.params.id);
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// DELETE /api/scheduled_posts/:id
scheduledPostsRouter.delete('/:id', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const db = await getDb();
    const filter: Record<string, unknown> = { _id: req.params.id };
    if (tenantId !== '__admin__') filter.tenantId = tenantId;
    const result = await db.collection('scheduled_posts').deleteOne(filter);
    if (!result.deletedCount) { res.status(404).json({ error: 'Not found' }); return; }
    stopPost(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST /api/scheduled_posts/:id/pause — toggle status
scheduledPostsRouter.post('/:id/pause', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const db = await getDb();
    const filter: Record<string, unknown> = { _id: req.params.id };
    if (tenantId !== '__admin__') filter.tenantId = tenantId;
    const post = await db.collection('scheduled_posts').findOne(filter, { projection: { status: 1 } }) as { status?: string } | null;
    if (!post) { res.status(404).json({ error: 'Not found' }); return; }
    const newStatus = post.status === 'active' ? 'paused' : 'active';
    await db.collection('scheduled_posts').updateOne(filter, { $set: { status: newStatus } });
    await reloadPost(req.params.id);
    res.json({ ok: true, status: newStatus });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
