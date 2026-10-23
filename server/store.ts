import { randomUUID } from "node:crypto";
import type { AppRecord, AuditEvent, CategoryResult, Finding, FindingState, PollState, ReleaseRecord, SignOff } from "../shared/types.ts";
import type { NewFinding } from "./normalize.ts";

export interface PipelineRef { sha: string; ref: string; isTag: boolean; pipelineId: number; pipelineUrl: string | null; author: string | null; createdAt: string }

export interface Store {
  listApps(): Promise<AppRecord[]>;
  getApp(id: string): Promise<AppRecord | null>;
  getAppByProject(project: string): Promise<AppRecord | null>;
  createApp(a: Omit<AppRecord, "id" | "createdAt">): Promise<AppRecord>;
  updateApp(id: string, patch: Partial<Omit<AppRecord, "id" | "createdAt" | "createdBy">>): Promise<AppRecord>;

  listReleases(appId?: string): Promise<ReleaseRecord[]>;
  getRelease(id: string): Promise<ReleaseRecord | null>;
  getReleaseBySha(appId: string, sha: string): Promise<ReleaseRecord | null>;
  /** Creates the release for a pipeline's commit, or returns the existing one. Marks older releases superseded. */
  upsertRelease(appId: string, p: PipelineRef): Promise<ReleaseRecord>;
  /** Stores a scan, replacing earlier findings for the release; carries risk decisions forward by fingerprint. */
  recordScan(releaseId: string, categories: CategoryResult[], findings: NewFinding[], at: string): Promise<void>;
  updateRelease(id: string, patch: Partial<Pick<ReleaseRecord, "targetDate" | "deployedAt" | "deployedTo">>): Promise<ReleaseRecord>;

  listFindings(releaseIds: string[]): Promise<Finding[]>;
  getFinding(id: string): Promise<Finding | null>;
  setFindingState(id: string, state: FindingState, by: string, note: string): Promise<Finding>;

  listSignoffs(releaseIds: string[]): Promise<SignOff[]>;
  addSignoff(s: Omit<SignOff, "id">): Promise<SignOff>;

  audit(e: Omit<AuditEvent, "id" | "at">): Promise<void>;
  listAudit(opts: { appId?: string; limit?: number }): Promise<AuditEvent[]>;

  getPoll(appId: string): Promise<PollState | null>;
  setPoll(p: PollState): Promise<void>;
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
export const versionOf = (p: Pick<PipelineRef, "ref" | "isTag" | "sha">) => (p.isTag ? p.ref : p.sha.slice(0, 8));

/** Risk decisions that survive a rescan: the same issue, already judged. */
export function carryForward(prior: Finding[], f: NewFinding): Pick<Finding, "state" | "stateBy" | "stateNote" | "stateAt"> {
  const p = prior.find((x) => x.fingerprint === f.fingerprint && (x.state === "accepted" || x.state === "false_positive"));
  if (!p) return { state: "open", stateBy: null, stateNote: null, stateAt: null };
  return { state: p.state, stateBy: p.stateBy, stateNote: `${p.stateNote ?? ""} (carried forward from an earlier release)`.trim(), stateAt: p.stateAt };
}

// ---------------- in memory (local development and tests) ----------------
export class MemoryStore implements Store {
  apps: AppRecord[] = [];
  releases: ReleaseRecord[] = [];
  findings: Finding[] = [];
  signoffs: SignOff[] = [];
  events: AuditEvent[] = [];
  polls = new Map<string, PollState>();
  private eventId = 0;

  async listApps() { return [...this.apps].sort((a, b) => a.name.localeCompare(b.name)); }
  async getApp(id: string) { return this.apps.find((a) => a.id === id) ?? null; }
  async getAppByProject(project: string) { return this.apps.find((a) => a.gitlabProject.toLowerCase() === project.toLowerCase()) ?? null; }
  async createApp(a: Omit<AppRecord, "id" | "createdAt">) {
    if (await this.getAppByProject(a.gitlabProject)) throw new Error("That GitLab project is already registered.");
    const rec: AppRecord = { ...a, id: newId("app"), createdAt: new Date().toISOString() };
    this.apps.push(rec);
    return rec;
  }
  async updateApp(id: string, patch: Partial<AppRecord>) {
    const a = await this.getApp(id);
    if (!a) throw new Error("not found");
    Object.assign(a, patch, { id: a.id, createdAt: a.createdAt, createdBy: a.createdBy });
    return a;
  }

  async listReleases(appId?: string) {
    return this.releases.filter((r) => !appId || r.appId === appId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getRelease(id: string) { return this.releases.find((r) => r.id === id) ?? null; }
  async getReleaseBySha(appId: string, sha: string) { return this.releases.find((r) => r.appId === appId && r.sha === sha) ?? null; }
  async upsertRelease(appId: string, p: PipelineRef) {
    const existing = await this.getReleaseBySha(appId, p.sha);
    if (existing) {
      // A tag pipeline for a commit we already have upgrades the version label.
      if (p.isTag && !existing.isTag) Object.assign(existing, { isTag: true, ref: p.ref, version: p.ref });
      if (p.pipelineId > (existing.pipelineId ?? 0)) Object.assign(existing, { pipelineId: p.pipelineId, pipelineUrl: p.pipelineUrl });
      return existing;
    }
    const rec: ReleaseRecord = {
      id: newId("rel"), appId, version: versionOf(p), sha: p.sha, ref: p.ref, isTag: p.isTag, pipelineId: p.pipelineId, pipelineUrl: p.pipelineUrl,
      author: p.author, createdAt: p.createdAt, scannedAt: null, targetDate: null, deployedAt: null, deployedTo: null, categories: [], supersededBy: null,
    };
    for (const r of this.releases) if (r.appId === appId && !r.supersededBy && !r.deployedAt && r.createdAt <= p.createdAt) r.supersededBy = rec.id;
    this.releases.push(rec);
    return rec;
  }
  async recordScan(releaseId: string, categories: CategoryResult[], findings: NewFinding[], at: string) {
    const rel = await this.getRelease(releaseId);
    if (!rel) throw new Error("not found");
    const priorIds = new Set(this.releases.filter((r) => r.appId === rel.appId).map((r) => r.id));
    const prior = this.findings.filter((f) => priorIds.has(f.releaseId));
    const carried = findings.map((f) => ({ ...f, id: newId("fnd"), releaseId, ...carryForward(prior, f) }));
    this.findings = this.findings.filter((f) => f.releaseId !== releaseId).concat(carried);
    rel.categories = categories;
    rel.scannedAt = at;
  }
  async updateRelease(id: string, patch: Partial<ReleaseRecord>) {
    const r = await this.getRelease(id);
    if (!r) throw new Error("not found");
    Object.assign(r, patch);
    return r;
  }

  async listFindings(releaseIds: string[]) { const s = new Set(releaseIds); return this.findings.filter((f) => s.has(f.releaseId)); }
  async getFinding(id: string) { return this.findings.find((f) => f.id === id) ?? null; }
  async setFindingState(id: string, state: FindingState, by: string, note: string) {
    const f = await this.getFinding(id);
    if (!f) throw new Error("not found");
    Object.assign(f, { state, stateBy: by, stateNote: note, stateAt: new Date().toISOString() });
    return f;
  }

  async listSignoffs(releaseIds: string[]) { const s = new Set(releaseIds); return this.signoffs.filter((x) => s.has(x.releaseId)); }
  async addSignoff(s: Omit<SignOff, "id">) { const rec = { ...s, id: newId("sig") }; this.signoffs.push(rec); return rec; }

  async audit(e: Omit<AuditEvent, "id" | "at">) { this.events.push({ ...e, id: ++this.eventId, at: new Date().toISOString() }); }
  async listAudit({ appId, limit = 200 }: { appId?: string; limit?: number }) {
    return this.events.filter((e) => !appId || e.appId === appId).slice(-limit).reverse();
  }

  async getPoll(appId: string) { return this.polls.get(appId) ?? null; }
  async setPoll(p: PollState) { this.polls.set(p.appId, { ...p }); }
}
