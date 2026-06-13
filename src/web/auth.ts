/**
 * auth.ts — JWT-based auth middleware (tenant-scoped)
 * Supports: Bearer JWT (tenant sessions) or X-Admin-Key (admin/scripts)
 */
import type { RequestHandler, Request } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export interface AuthPayload {
  tenantId: string;
  email: string;
  isAdmin?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

export const requireAuth: RequestHandler = (req, res, next) => {
  // Admin key bypasses JWT (scripts, internal tooling)
  const adminKey = String(req.headers['x-admin-key'] ?? req.query['admin_key'] ?? '');
  if (adminKey && adminKey === config.admin.apiKey) {
    req.auth = { tenantId: '__admin__', email: 'admin', isAdmin: true };
    return next();
  }

  const authHeader = String(req.headers['authorization'] ?? '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  if (!token) {
    res.status(401).json({ error: 'Token de autenticação não fornecido' });
    return;
  }

  try {
    const payload = jwt.verify(token, config.jwt.secret) as AuthPayload;
    req.auth = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado' });
  }
};

/** For routes that need only admin access */
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!req.auth?.isAdmin) {
    res.status(403).json({ error: 'Acesso restrito a administradores' });
    return;
  }
  next();
};

export function signTenantToken(tenantId: string, email: string): string {
  return jwt.sign(
    { tenantId, email } satisfies AuthPayload,
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn as jwt.SignOptions['expiresIn'] },
  );
}
