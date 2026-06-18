import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import {
  getUserByUsername,
  getUserById,
  verifyPassword,
  userAllowedGroups,
  type Role,
} from './services/users.js';
import type { MachineGroup } from './services/groups.js';

export interface AuthPayload {
  id: number;
  username: string;
  role: Role;
  allowedGroups: MachineGroup[];
}

export interface AuthedRequest extends Request {
  user?: AuthPayload;
}

function rowRole(role: string): Role {
  return role === 'admin' ? 'admin' : 'user';
}

export function signToken(payload: AuthPayload): string {
  const opts: jwt.SignOptions = {
    expiresIn: config.auth.tokenTtl as jwt.SignOptions['expiresIn'],
  };
  return jwt.sign(payload, config.auth.jwtSecret, opts);
}

/** Validate credentials; returns the auth payload or null. */
export function authenticate(username: string, password: string): AuthPayload | null {
  const row = getUserByUsername(username.trim());
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  const role = rowRole(row.role);
  return { id: row.id, username: row.username, role, allowedGroups: userAllowedGroups(row.id, role) };
}

function bearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.slice(7) : null;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Niste prijavljeni' });
    return;
  }
  try {
    const decoded = jwt.verify(token, config.auth.jwtSecret) as { id?: number };
    // Re-load the user so deletions/role changes take effect immediately.
    const row = decoded.id !== undefined ? getUserById(Number(decoded.id)) : undefined;
    if (!row) {
      res.status(401).json({ error: 'Korisnik ne postoji' });
      return;
    }
    const role = rowRole(row.role);
    req.user = { id: row.id, username: row.username, role, allowedGroups: userAllowedGroups(row.id, role) };
    next();
  } catch {
    res.status(401).json({ error: 'Sesija je istekla, prijavite se ponovno' });
  }
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Nemate ovlasti za ovu radnju' });
      return;
    }
    next();
  });
}
