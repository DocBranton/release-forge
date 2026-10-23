// Databricks platform access as the app's service principal (Databricks Apps injects
// DATABRICKS_HOST, DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET).
import pg from "pg";

export function host(env = process.env): string {
  const h = env.DATABRICKS_HOST ?? "";
  return h ? (h.startsWith("http") ? h : `https://${h}`).replace(/\/$/, "") : "";
}

let sp: { value: string; exp: number } | null = null;
export async function servicePrincipalToken(env = process.env, fetchFn: typeof fetch = fetch): Promise<string> {
  if (sp && sp.exp > Date.now() + 120_000) return sp.value;
  const id = env.DATABRICKS_CLIENT_ID, secret = env.DATABRICKS_CLIENT_SECRET, base = host(env);
  if (!id || !secret || !base) throw new Error("No Databricks service principal credentials (DATABRICKS_HOST / CLIENT_ID / CLIENT_SECRET).");
  const r = await fetchFn(`${base}/oidc/v1/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&scope=all-apis",
  });
  if (!r.ok) throw new Error(`Service principal sign-in failed (${r.status}).`);
  const t = (await r.json()) as { access_token: string; expires_in?: number };
  sp = { value: t.access_token, exp: Date.now() + (t.expires_in ?? 3600) * 1000 };
  return sp.value;
}

let dbCred: { value: string; exp: number } | null = null;
/** A Lakebase database credential for the app's service principal; used as the Postgres password. */
export async function lakebasePassword(env = process.env, fetchFn: typeof fetch = fetch): Promise<string> {
  if (dbCred && dbCred.exp > Date.now() + 120_000) return dbCred.value;
  const endpoint = env.LAKEBASE_ENDPOINT;
  if (!endpoint) throw new Error("LAKEBASE_ENDPOINT is not set.");
  const r = await fetchFn(`${host(env)}/api/2.0/postgres/credentials`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await servicePrincipalToken(env, fetchFn)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
  if (!r.ok) throw new Error(`Lakebase credential request failed (${r.status}).`);
  const t = (await r.json()) as { token: string; expire_time?: string };
  dbCred = { value: t.token, exp: t.expire_time ? Date.parse(t.expire_time) : Date.now() + 3_600_000 };
  return dbCred.value;
}

/** Postgres pool for Lakebase. PGHOST, PGPORT, PGDATABASE, PGUSER and PGSSLMODE come from the app's postgres resource. */
export function lakebasePool(env = process.env): pg.Pool {
  return new pg.Pool({
    host: env.PGHOST,
    port: Number(env.PGPORT ?? 5432),
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: () => lakebasePassword(env),
    ssl: env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: true },
    max: 8,
    idleTimeoutMillis: 30_000,
  });
}
