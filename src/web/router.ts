import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth, signTenantToken } from './auth.js';
import { config } from '../config.js';
import { checkWcSubscription, findOrCreateTenant, sendMagicLink } from '../services/provisioning.js';
import { tenantsRouter } from './routes/tenants.js';
import { agentsRouter } from './routes/agents.js';
import { knowledgeRouter } from './routes/knowledge.js';
import { scheduledPostsRouter } from './routes/scheduled_posts.js';
import { conversationsRouter } from './routes/conversations.js';

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

// All routes below require auth
apiRouter.use(requireAuth);
apiRouter.use('/tenants', tenantsRouter);
apiRouter.use('/agents', agentsRouter);
apiRouter.use('/knowledge', knowledgeRouter);
apiRouter.use('/scheduled_posts', scheduledPostsRouter);
apiRouter.use('/conversations', conversationsRouter);
