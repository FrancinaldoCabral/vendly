/**
 * conversations.ts — Conversation history (read-only)
 */
import { Router } from 'express';
import { getDb } from '../../tools/mongodb.js';
import { getRedis } from '../../tools/redis.js';

export const conversationsRouter = Router();

// GET /api/conversations?agentId=&senderPhone=&page=&limit=
conversationsRouter.get('/', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const db = await getDb();
    const filter: Record<string, unknown> = {};
    if (tenantId !== '__admin__') filter.tenantId = tenantId;
    if (req.query.agentId) filter.agentId = String(req.query.agentId);
    if (req.query.senderPhone) filter.senderPhone = String(req.query.senderPhone);

    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const page = Number(req.query.page ?? 0);

    const conversations = await db.collection('conversations')
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(page * limit)
      .limit(limit)
      .toArray();

    const total = await db.collection('conversations').countDocuments(filter);
    res.json({ data: conversations, total, page, limit });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// DELETE /api/conversations/session?agentId=&conversationId= — clear Redis session
conversationsRouter.delete('/session', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const agentId = String(req.query.agentId ?? '');
    const conversationId = String(req.query.conversationId ?? '');
    if (!agentId || !conversationId) {
      res.status(400).json({ error: 'agentId e conversationId obrigatórios' }); return;
    }

    const redis = getRedis();
    const sessionKey = `sessao:t:${tenantId}:${agentId}:${conversationId}`;
    await redis.del(sessionKey);
    res.json({ ok: true, deleted: sessionKey });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
