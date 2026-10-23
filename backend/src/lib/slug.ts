import crypto from 'crypto';
import { prisma } from '../db';

// "My Cool App!" -> "my-cool-app-a1b2c3". The random suffix keeps slugs unique and unguessable,
// and stops anyone claiming names like "www" or "admin".
export function makeSlug(name: string, rand: () => string = () => crypto.randomBytes(3).toString('hex')): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'app';
  return `${base}-${rand()}`;
}

// Give a project a slug if it has none (projects created before subdomains existed).
export async function ensureSlug(projectId: string, name: string): Promise<string> {
  const existing = await prisma.project.findUnique({ where: { id: projectId }, select: { slug: true } });
  if (existing?.slug) return existing.slug;
  for (let i = 0; i < 5; i++) {
    const slug = makeSlug(name);
    try {
      const { count } = await prisma.project.updateMany({ where: { id: projectId, slug: null }, data: { slug } });
      if (count === 1) return slug;
      return (await prisma.project.findUnique({ where: { id: projectId }, select: { slug: true } }))!.slug!;
    } catch (e: any) {
      if (e?.code !== 'P2002') throw e; // unique clash: try another suffix
    }
  }
  throw new Error('Could not generate a unique slug');
}

export async function backfillSlugs() {
  const missing = await prisma.project.findMany({ where: { slug: null }, select: { id: true, name: true } });
  for (const p of missing) await ensureSlug(p.id, p.name);
  if (missing.length) console.log(`Backfilled slugs for ${missing.length} project(s)`);
}
