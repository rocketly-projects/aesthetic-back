import { like } from 'drizzle-orm'
import { businesses } from '../db/schema'
import type { DB } from './db'

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export async function createUniqueSlug(db: DB, name: string): Promise<string> {
  const base = slugify(name)
  const existing = await db
    .select({ slug: businesses.slug })
    .from(businesses)
    .where(like(businesses.slug, `${base}%`))

  const slugs = new Set(existing.map((b) => b.slug))
  if (!slugs.has(base)) return base

  let i = 2
  while (slugs.has(`${base}${i}`)) i++
  return `${base}${i}`
}
