import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { HttpError } from '../lib/errors';
import { authenticate, signToken } from '../middleware/auth';

export const authRouter = Router();

const creds = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(128),
});

const publicUser = (u: { id: string; email: string; role: string; createdAt: Date }) => ({
  id: u.id,
  email: u.email,
  role: u.role,
  createdAt: u.createdAt,
});

// The first account created becomes ADMIN; everyone after is USER.
authRouter.post('/register', async (req, res) => {
  const { email, password } = creds.parse(req.body);
  if (await prisma.user.findUnique({ where: { email } })) throw new HttpError(409, 'Email already registered');
  const isFirst = (await prisma.user.count()) === 0;
  const user = await prisma.user.create({
    data: { email, passwordHash: await bcrypt.hash(password, 12), role: isFirst ? 'ADMIN' : 'USER' },
  });
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

authRouter.post('/login', async (req, res) => {
  const { email, password } = creds.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = user && (await bcrypt.compare(password, user.passwordHash));
  if (!user || !ok) throw new HttpError(401, 'Invalid credentials');
  res.json({ token: signToken(user), user: publicUser(user) });
});

authRouter.get('/me', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  res.json(publicUser(user!));
});
