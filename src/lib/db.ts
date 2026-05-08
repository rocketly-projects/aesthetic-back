import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '../db/schema'

export function createDb(url: string) {
  const client = postgres(url, { prepare: false })
  return drizzle(client, { schema })
}

export type DB = ReturnType<typeof createDb>
