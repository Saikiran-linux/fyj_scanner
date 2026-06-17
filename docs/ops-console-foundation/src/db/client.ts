import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema";

export type DB = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/**
 * The authenticated caller, resolved by Better Auth + a memberships/clients
 * lookup. This is what gets stamped into the per-request Postgres GUCs that
 * RLS reads (see db/policies.sql).
 */
export type Principal =
  | { principal: "staff"; userId: string; orgId: string; role: "admin" | "operator" | "viewer" }
  | { principal: "client"; userId: string; orgId: string; clientId: string };

/**
 * One pool per Worker isolate. `fetch_types: false` avoids the extra round-trip
 * that postgres.js otherwise makes to introspect types — recommended over
 * Hyperdrive. Pass `env.HYPERDRIVE.connectionString` in the Worker.
 */
export function createDb(connectionString: string): { db: DB; close: () => Promise<void> } {
  const client = postgres(connectionString, { max: 5, fetch_types: false });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end() };
}

/**
 * THE tenant-isolation primitive. Every tenant-scoped query MUST run inside this.
 * It opens a transaction and sets the request's claims as LOCAL GUCs via
 * `set_config(..., is_local => true)` — parameterized, so no injection — then
 * runs `fn` against that transaction. RLS does the rest; if any of these were
 * omitted the GUCs would be null and every policy would deny (fail closed).
 *
 * The repository layer (src/db/repo.ts) is the only thing that should call this,
 * so callers can't accidentally talk to the DB outside a tenant context.
 */
export async function withTenant<T>(db: DB, who: Principal, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${who.userId}, true)`);
    await tx.execute(sql`select set_config('app.principal', ${who.principal}, true)`);
    await tx.execute(sql`select set_config('app.org_id', ${who.orgId}, true)`);
    if (who.principal === "staff") {
      await tx.execute(sql`select set_config('app.role', ${who.role}, true)`);
    } else {
      await tx.execute(sql`select set_config('app.client_id', ${who.clientId}, true)`);
    }
    return fn(tx);
  });
}

export { schema };
