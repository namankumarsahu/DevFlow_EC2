import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../db';
import { HttpError } from '../lib/errors';

export type Role = 'USER' | 'ADMIN';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; role: Role };
    }
  }
}

export const signToken = (u: { id: string; role: Role }) =>
  jwt.sign({ sub: u.id, role: u.role }, config.jwtSecret, { expiresIn: '12h' });

export function verifyToken(token: string): { id: string } {
  const p = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
  if (!p.sub) throw new Error('bad token');
  return { id: p.sub };
}

// Verifies the JWT, then loads the user so deleted users / role changes take effect immediately.
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw new HttpError(401, 'Missing token');
  let id: string;
  try {
    id = verifyToken(h.slice(7)).id;
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new HttpError(401, 'User no longer exists');
  req.user = { id: user.id, role: user.role as Role };
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'ADMIN') throw new HttpError(403, 'Admin access required');
  next();
}
