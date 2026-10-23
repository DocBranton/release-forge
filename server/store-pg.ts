// Lakebase (Postgres) store. Every statement is parameterized; identifiers are constants.
import type { Pool, PoolClient } from "pg";
import type { AppRecord, AuditEvent, CategoryResult, Finding, FindingState, PollState, ReleaseRecord, SignOff } from "../shared/types.ts";
import type { NewFinding } from "./normalize.ts";
import { carryForward, newId, versionOf, type PipelineRef, type Store } from "./store.ts";

const S = "release_forge";

const DDL = [
  `CREATE SCHEMA IF NOT EXISTS ${S}`,
  `CREATE TABLE IF NOT EXISTS ${S}.apps (
     id text PRIMARY KEY, name text NOT NULL, program text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '',
     gitlab_project text NOT NULL, default_branch text NOT NULL DEFAULT 'main', environments jsonb NOT NULL DEFAULT '[]',
     required_roles jsonb NOT NULL DEFAULT '[]', reviewers jsonb NOT NULL DEFAULT '{}', block_on jsonb NOT NULL DEFAULT '["Critical","High"]',
     required_scans jsonb NOT NULL DEFAULT '["sast","secrets","sbom"]', owner text NOT NULL DEFAULT '',
     created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS apps_project ON ${S}.apps (lower(gitlab_project))`,
  `CREATE TABLE IF NOT EXISTS ${S}.releases (
     id text PRIMARY KEY, app_id text NOT NULL REFERENCES ${S}.apps(id), version text NOT NULL, sha text NOT NULL, ref text NOT NULL,
     is_tag boolean NOT NULL DEFAULT false, pipeline_id bigint, pipeline_url text, author text, created_at timestamptz NOT NULL,
     scanned_at timestamptz, target_date date, deployed_at timestamptz, deployed_to text, categories jsonb NOT NULL DEFAULT '[]',
     superseded_by text, UNIQUE (app_id, sha))`,
  `CREATE INDEX IF NOT EXISTS releases_app ON ${S}.releases (app_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS ${S}.findings (
     id text PRIMARY KEY, release_id text NOT NULL REFERENCES ${S}.releases(id) ON DELETE CASCADE, fingerprint text NOT NULL,
     category text NOT NULL, severity text NOT NULL CHECK (severity IN ('Critical','High','Medium','Low','Info')), tool text NOT NULL,
     rule text NOT NULL, title text NOT NULL, path text NOT NULL, line integer, recommendation text NOT NULL,
     state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','accepted','false_positive','fixed')),
     state_by text, state_note text, state_at timestamptz)`,
  `CREATE INDEX IF NOT EXISTS findings_release ON ${S}.findings (release_id)`,
  `CREATE TABLE IF NOT EXISTS ${S}.signoffs (
     id text PRIMARY KEY, release_id text NOT NULL REFERENCES ${S}.releases(id), sha text NOT NULL, role text NOT NULL,
     reviewer text NOT NULL, decision text NOT NULL CHECK (decision IN ('approved','rejected')), comment text NOT NULL DEFAULT '',
     at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS signoffs_release ON ${S}.signoffs (release_id)`,
  `CREATE TABLE IF NOT EXISTS ${S}.audit (
     id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), actor text NOT NULL, action text NOT NULL,
     app_id text, release_id text, detail jsonb NOT NULL DEFAULT '{}')`,
  `CREATE INDEX IF NOT EXISTS audit_app ON ${S}.audit (app_id, at DESC)`,
  `CREATE TABLE IF NOT EXISTS ${S}.poll_state (
     app_id text PRIMARY KEY REFERENCES ${S}.apps(id), last_pipeline_id bigint NOT NULL DEFAULT 0,
     last_polled_at timestamptz, last_error text)`,
];

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const day = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

const appRow = (r: any): AppRecord => ({
  id: r.id, name: r.name, program: r.program, description: r.description, gitlabProject: r.gitlab_project, defaultBranch: r.default_branch,
  environments: r.environments, requiredRoles: r.required_roles, reviewers: r.reviewers, blockOn: r.block_on, requiredScans: r.required_scans,
  owner: r.owner, createdAt: iso(r.created_at)!, createdBy: r.created_by,
});
const relRow = (r: any): ReleaseRecord => ({
  id: r.id, appId: r.app_id, version: r.version, sha: r.sha, ref: r.ref, isTag: r.is_tag, pipelineId: r.pipeline_id == null ? null : Number(r.pipeline_id),
  pipelineUrl: r.pipeline_url, author: r.author, createdAt: iso(r.created_at)!, scannedAt: iso(r.scanned_at), targetDate: day(r.target_date),
  deployedAt: iso(r.deployed_at), deployedTo: r.deployed_to, categories: r.categories as CategoryResult[], supersededBy: r.superseded_by,
});
const fRow = (r: any): Finding => ({
  id: r.id, releaseId: r.release_id, fingerprint: r.fingerprint, category: r.category, severity: r.severity, tool: r.tool, rule: r.rule, title: r.title,
  path: r.path, line: r.line, recommendation: r.recommendation, state: r.state, stateBy: r.state_by, stateNote: r.state_note, stateAt: iso(r.state_at),
});
const sRow = (r: any): SignOff => ({ id: r.id, releaseId: r.release_id, sha: r.sha, role: r.role, reviewer: r.reviewer, decision: r.decision, comment: r.comment, at: iso(r.at)! });

export class PgStore implements Store {
  constructor(private db: Pool) {}

  async ensureSchema() { for (const sql of DDL) await this.db.query(sql); }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.db.connect();
    try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
    catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
    finally { c.release(); }
  }

  async listApps() { return (await this.db.query(`SELECT * FROM ${S}.apps ORDER BY name`)).rows.map(appRow); }
  async getApp(id: string) { const r = (await this.db.query(`SELECT * FROM ${S}.apps WHERE id = $1`, [id])).rows[0]; return r ? appRow(r) : null; }
  async getAppByProject(p: string) { const r = (await this.db.query(`SELECT * FROM ${S}.apps WHERE lower(gitlab_project) = lower($1)`, [p])).rows[0]; return r ? appRow(r) : null; }
  async createApp(a: Omit<AppRecord, "id" | "createdAt">) {
    if (await this.getAppByProject(a.gitlabProject)) throw new Error("That GitLab project is already registered.");
    const r = await this.db.query(
      `INSERT INTO ${S}.apps (id, name, program, description, gitlab_project, default_branch, environments, required_roles, reviewers, block_on, required_scans, owner, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [newId("app"), a.name, a.program, a.description, a.gitlabProject, a.defaultBranch, JSON.stringify(a.environments), JSON.stringify(a.requiredRoles),
        JSON.stringify(a.reviewers), JSON.stringify(a.blockOn), JSON.stringify(a.requiredScans), a.owner, a.createdBy]);
    return appRow(r.rows[0]);
  }
  async updateApp(id: string, p: Partial<AppRecord>) {
    const cur = await this.getApp(id);
    if (!cur) throw new Error("not found");
    const a = { ...cur, ...p };
    const r = await this.db.query(
      `UPDATE ${S}.apps SET name=$2, program=$3, description=$4, gitlab_project=$5, default_branch=$6, environments=$7, required_roles=$8,
         reviewers=$9, block_on=$10, required_scans=$11, owner=$12 WHERE id=$1 RETURNING *`,
      [id, a.name, a.program, a.description, a.gitlabProject, a.defaultBranch, JSON.stringify(a.environments), JSON.stringify(a.requiredRoles),
        JSON.stringify(a.reviewers), JSON.stringify(a.blockOn), JSON.stringify(a.requiredScans), a.owner]);
    return appRow(r.rows[0]);
  }

  async listReleases(appId?: string) {
    const r = appId
      ? await this.db.query(`SELECT * FROM ${S}.releases WHERE app_id = $1 ORDER BY created_at DESC LIMIT 500`, [appId])
      : await this.db.query(`SELECT * FROM ${S}.releases ORDER BY created_at DESC LIMIT 5000`);
    return r.rows.map(relRow);
  }
  async getRelease(id: string) { const r = (await this.db.query(`SELECT * FROM ${S}.releases WHERE id = $1`, [id])).rows[0]; return r ? relRow(r) : null; }
  async getReleaseBySha(appId: string, sha: string) { const r = (await this.db.query(`SELECT * FROM ${S}.releases WHERE app_id = $1 AND sha = $2`, [appId, sha])).rows[0]; return r ? relRow(r) : null; }
  async upsertRelease(appId: string, p: PipelineRef) {
    return this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`rf-release:${appId}`]);
      const ex = (await c.query(`SELECT * FROM ${S}.releases WHERE app_id = $1 AND sha = $2`, [appId, p.sha])).rows[0];
      if (ex) {
        const r = await c.query(
          `UPDATE ${S}.releases SET
             is_tag = is_tag OR $3, ref = CASE WHEN $3 AND NOT is_tag THEN $4 ELSE ref END, version = CASE WHEN $3 AND NOT is_tag THEN $4 ELSE version END,
             pipeline_id = GREATEST(COALESCE(pipeline_id, 0), $5), pipeline_url = CASE WHEN $5 > COALESCE(pipeline_id, 0) THEN $6 ELSE pipeline_url END
           WHERE app_id = $1 AND sha = $2 RETURNING *`,
          [appId, p.sha, p.isTag, p.ref, p.pipelineId, p.pipelineUrl]);
        return relRow(r.rows[0]);
      }
      const id = newId("rel");
      const r = await c.query(
        `INSERT INTO ${S}.releases (id, app_id, version, sha, ref, is_tag, pipeline_id, pipeline_url, author, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [id, appId, versionOf(p), p.sha, p.ref, p.isTag, p.pipelineId, p.pipelineUrl, p.author, p.createdAt]);
      await c.query(`UPDATE ${S}.releases SET superseded_by = $1 WHERE app_id = $2 AND id <> $1 AND superseded_by IS NULL AND deployed_at IS NULL AND created_at <= $3`, [id, appId, p.createdAt]);
      return relRow(r.rows[0]);
    });
  }
  async recordScan(releaseId: string, categories: CategoryResult[], findings: NewFinding[], at: string) {
    await this.tx(async (c) => {
      const rel = (await c.query(`SELECT app_id FROM ${S}.releases WHERE id = $1 FOR UPDATE`, [releaseId])).rows[0];
      if (!rel) throw new Error("not found");
      const prior = (await c.query(
        `SELECT f.* FROM ${S}.findings f JOIN ${S}.releases r ON r.id = f.release_id WHERE r.app_id = $1 AND f.state IN ('accepted','false_positive')`, [rel.app_id])).rows.map(fRow);
      await c.query(`DELETE FROM ${S}.findings WHERE release_id = $1`, [releaseId]);
      for (const f of findings) {
        const st = carryForward(prior, f);
        await c.query(
          `INSERT INTO ${S}.findings (id, release_id, fingerprint, category, severity, tool, rule, title, path, line, recommendation, state, state_by, state_note, state_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [newId("fnd"), releaseId, f.fingerprint, f.category, f.severity, f.tool, f.rule, f.title, f.path, f.line, f.recommendation, st.state, st.stateBy, st.stateNote, st.stateAt]);
      }
      await c.query(`UPDATE ${S}.releases SET categories = $2, scanned_at = $3 WHERE id = $1`, [releaseId, JSON.stringify(categories), at]);
    });
  }
  async updateRelease(id: string, p: Partial<ReleaseRecord>) {
    const cur = await this.getRelease(id);
    if (!cur) throw new Error("not found");
    const n = { ...cur, ...p };
    const r = await this.db.query(`UPDATE ${S}.releases SET target_date = $2, deployed_at = $3, deployed_to = $4 WHERE id = $1 RETURNING *`, [id, n.targetDate, n.deployedAt, n.deployedTo]);
    return relRow(r.rows[0]);
  }

  async listFindings(ids: string[]) {
    if (!ids.length) return [];
    return (await this.db.query(`SELECT * FROM ${S}.findings WHERE release_id = ANY($1)`, [ids])).rows.map(fRow);
  }
  async getFinding(id: string) { const r = (await this.db.query(`SELECT * FROM ${S}.findings WHERE id = $1`, [id])).rows[0]; return r ? fRow(r) : null; }
  async setFindingState(id: string, state: FindingState, by: string, note: string) {
    const r = await this.db.query(`UPDATE ${S}.findings SET state = $2, state_by = $3, state_note = $4, state_at = now() WHERE id = $1 RETURNING *`, [id, state, by, note]);
    if (!r.rows[0]) throw new Error("not found");
    return fRow(r.rows[0]);
  }

  async listSignoffs(ids: string[]) {
    if (!ids.length) return [];
    return (await this.db.query(`SELECT * FROM ${S}.signoffs WHERE release_id = ANY($1) ORDER BY at`, [ids])).rows.map(sRow);
  }
  async addSignoff(s: Omit<SignOff, "id">) {
    const r = await this.db.query(
      `INSERT INTO ${S}.signoffs (id, release_id, sha, role, reviewer, decision, comment, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [newId("sig"), s.releaseId, s.sha, s.role, s.reviewer, s.decision, s.comment, s.at]);
    return sRow(r.rows[0]);
  }

  async audit(e: Omit<AuditEvent, "id" | "at">) {
    await this.db.query(`INSERT INTO ${S}.audit (actor, action, app_id, release_id, detail) VALUES ($1,$2,$3,$4,$5)`, [e.actor, e.action, e.appId, e.releaseId, JSON.stringify(e.detail)]);
  }
  async listAudit({ appId, limit = 200 }: { appId?: string; limit?: number }) {
    const lim = Math.min(Math.max(limit, 1), 1000);
    const r = appId
      ? await this.db.query(`SELECT * FROM ${S}.audit WHERE app_id = $1 ORDER BY at DESC LIMIT $2`, [appId, lim])
      : await this.db.query(`SELECT * FROM ${S}.audit ORDER BY at DESC LIMIT $1`, [lim]);
    return r.rows.map((x: any) => ({ id: Number(x.id), at: iso(x.at)!, actor: x.actor, action: x.action, appId: x.app_id, releaseId: x.release_id, detail: x.detail }));
  }

  async getPoll(appId: string) {
    const r = (await this.db.query(`SELECT * FROM ${S}.poll_state WHERE app_id = $1`, [appId])).rows[0];
    return r ? { appId: r.app_id, lastPipelineId: Number(r.last_pipeline_id), lastPolledAt: iso(r.last_polled_at), lastError: r.last_error } : null;
  }
  async setPoll(p: PollState) {
    await this.db.query(
      `INSERT INTO ${S}.poll_state (app_id, last_pipeline_id, last_polled_at, last_error) VALUES ($1,$2,$3,$4)
       ON CONFLICT (app_id) DO UPDATE SET last_pipeline_id = EXCLUDED.last_pipeline_id, last_polled_at = EXCLUDED.last_polled_at, last_error = EXCLUDED.last_error`,
      [p.appId, p.lastPipelineId, p.lastPolledAt, p.lastError]);
  }
}
