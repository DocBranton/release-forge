// Polls each registered application's GitLab pipelines and ingests Release Forge scan artifacts.
import type { AppRecord } from "../shared/types.ts";
import type { GitLab, GlPipeline } from "./gitlab.ts";
import { ARTIFACT_FILES, normalizeAll, type ArtifactKey, type RawArtifacts } from "./normalize.ts";
import type { Store } from "./store.ts";

/** CI job names from ci/release-forge.gitlab-ci.yml and the artifact each one writes. */
export const SCAN_JOBS: Record<string, ArtifactKey> = {
  "rf-semgrep": "semgrep",
  "rf-gitleaks": "gitleaks",
  "rf-npm-audit": "npmAudit",
  "rf-checkov": "checkov",
  "rf-clamav": "clamav",
  "rf-bundle": "bundle",
};

/** Release candidates are pushes to the default branch and tags; schedules and merge requests are not. */
export function isReleasePipeline(app: AppRecord, p: GlPipeline): boolean {
  if (p.source && ["schedule", "merge_request_event", "parent_pipeline", "pipeline"].includes(p.source)) return false;
  return p.tag === true || p.ref === app.defaultBranch;
}

export type IngestResult = { status: "ingested"; releaseId: string; findings: number } | { status: "ignored"; reason: string };

export async function ingestPipeline(store: Store, gl: GitLab, app: AppRecord, pipelineId: number): Promise<IngestResult> {
  const p = await gl.pipeline(app.gitlabProject, pipelineId);
  if (!p) return { status: "ignored", reason: "pipeline not found" };
  if (!isReleasePipeline(app, p)) return { status: "ignored", reason: `not a release pipeline (ref ${p.ref}, source ${p.source ?? "?"})` };
  const jobs = await gl.jobs(app.gitlabProject, p.id);
  const raw: RawArtifacts = {};
  for (const j of jobs) {
    const key = SCAN_JOBS[j.name];
    if (!key || raw[key] != null) continue;
    // Scanner jobs keep artifacts `when: always`, so a failed scanner still reports.
    raw[key] = await gl.artifact(app.gitlabProject, j.id, ARTIFACT_FILES[key]);
  }
  const release = await store.upsertRelease(app.id, {
    sha: p.sha, ref: p.ref, isTag: p.tag === true, pipelineId: p.id, pipelineUrl: p.web_url ?? null,
    author: p.user?.username ?? null, createdAt: new Date(p.created_at).toISOString(),
  });
  const { categories, findings } = normalizeAll(raw);
  await store.recordScan(release.id, categories, findings, new Date().toISOString());
  await store.audit({
    actor: "release-forge", action: "scan.ingested", appId: app.id, releaseId: release.id,
    detail: { pipelineId: p.id, sha: p.sha, ref: p.ref, findings: findings.length, scanJobs: Object.keys(raw).length },
  });
  return { status: "ingested", releaseId: release.id, findings: findings.length };
}

/** One poll of one app: ingest finished release pipelines newer than the last one seen. */
export async function pollApp(store: Store, gl: GitLab, app: AppRecord): Promise<{ ingested: number; error?: string }> {
  const state = (await store.getPoll(app.id)) ?? { appId: app.id, lastPipelineId: 0, lastPolledAt: null, lastError: null };
  let ingested = 0;
  try {
    const list = (await gl.pipelines(app.gitlabProject)).filter((p) => p.id > state.lastPipelineId && isReleasePipeline(app, p));
    // First poll of a new app: only its latest release pipeline, not a backfill of history.
    const todo = (state.lastPipelineId === 0 ? list.slice(0, 1) : list).sort((a, b) => a.id - b.id);
    for (const p of todo) {
      const r = await ingestPipeline(store, gl, app, p.id);
      if (r.status === "ingested") ingested++;
      state.lastPipelineId = Math.max(state.lastPipelineId, p.id);
    }
    await store.setPoll({ ...state, lastPolledAt: new Date().toISOString(), lastError: null });
    return { ingested };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await store.setPoll({ ...state, lastPolledAt: new Date().toISOString(), lastError: msg });
    return { ingested, error: msg };
  }
}

export function startPoller(store: Store, gl: GitLab, everyMs: number, log = console) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const app of await store.listApps()) {
        const r = await pollApp(store, gl, app);
        if (r.ingested || r.error) log.log(`[poll] ${app.gitlabProject}: ${r.ingested} ingested${r.error ? `, error: ${r.error}` : ""}`);
      }
    } catch (e) { log.error("[poll]", (e as Error).message); }
    finally { running = false; }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  void tick();
  return { stop: () => clearInterval(timer), tick };
}
