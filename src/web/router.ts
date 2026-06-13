import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth, signTenantToken } from './auth.js';
import { config } from '../config.js';
import { tenantsRouter } from './routes/tenants.js';
import { agentsRouter } from './routes/agents.js';
import { knowledgeRouter } from './routes/knowledge.js';
import { scheduledPostsRouter } from './routes/scheduled_posts.js';
import { conversationsRouter } from './routes/conversations.js';

export const apiRouter = Router();

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

// All routes below require auth
apiRouter.use(requireAuth);
apiRouter.use('/tenants', tenantsRouter);
apiRouter.use('/agents', agentsRouter);
apiRouter.use('/knowledge', knowledgeRouter);
apiRouter.use('/scheduled_posts', scheduledPostsRouter);
apiRouter.use('/conversations', conversationsRouter);
