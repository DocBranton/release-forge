import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.ts";
import { lakebasePool } from "./databricks.ts";
import { GitLab } from "./gitlab.ts";
import { startPoller } from "./ingest.ts";
import { seedDemo } from "./seed.ts";
import { MemoryStore, type Store } from "./store.ts";
import { PgStore } from "./store-pg.ts";

const env = process.env;
const prod = env.NODE_ENV === "production";

async function makeStore(): Promise<Store> {
  if (env.PGHOST && env.LAKEBASE_ENDPOINT) {
    const pg = new PgStore(lakebasePool());
    await pg.ensureSchema();
    console.log("[store] Lakebase (schema release_forge)");
    return pg;
  }
  if (prod) throw new Error("No Lakebase database configured. Add the postgres app resource (see README); production does not run on in-memory storage.");
  console.log("[store] in memory (development only; data is lost on restart)");
  return new MemoryStore();
}

async function main() {
  const store = await makeStore();
  if (!prod && env.RF_SEED_DEMO === "1") {
    await seedDemo(store, (env.RF_DEV_USER || "dev@example.mil").toLowerCase());
    console.log("[seed] demo data loaded");
  }
  if (!(env.APP_ADMINS ?? "").trim()) console.warn("[auth] APP_ADMINS is empty: nobody can register applications until it is set.");

  const gitlab = env.GITLAB_URL && env.GITLAB_TOKEN ? new GitLab(env.GITLAB_URL, env.GITLAB_TOKEN) : null;
  if (gitlab) {
    const every = Math.max(60, Number(env.RF_POLL_SECONDS ?? 300)) * 1000;
    startPoller(store, gitlab, every);
    console.log(`[poll] polling ${env.GITLAB_URL} every ${every / 1000}s`);
  } else console.log("[poll] GitLab not configured (GITLAB_URL / GITLAB_TOKEN); polling is off");

  const here = dirname(fileURLToPath(import.meta.url));
  const client = [resolve(here, "../../client/dist"), resolve(here, "../client/dist")].find((p) => existsSync(p));
  const ui = { classification: (env.RF_CLASSIFICATION ?? "").slice(0, 80), gitlabUrl: env.GITLAB_URL ? env.GITLAB_URL.replace(/\/$/, "") : null, demo: !prod && env.RF_SEED_DEMO === "1" };
  const app = buildApp({ store, gitlab, publicUrl: env.RF_PUBLIC_URL || env.DATABRICKS_APP_URL, clientDir: client, ui });

  const port = Number(env.DATABRICKS_APP_PORT ?? env.PORT ?? 8000);
  app.listen(port, () => console.log(`[server] Release Forge on :${port}`));
}

main().catch((e) => { console.error("[server] failed to start:", e); process.exit(1); });
