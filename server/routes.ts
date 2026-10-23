import { Router, type Request, type Response } from "express";
import { CATEGORIES, ROLES, SEVERITIES, type AppRecord, type CategoryKey, type RoleKey, type Severity } from "../shared/types.ts";
import { isAdmin, isGatePrincipal, me, rateLimit, type Actor } from "./auth.ts";
import type { GitLab } from "./gitlab.ts";
import { ingestPipeline, pollApp } from "./ingest.ts";
import { canSign, isAuthor } from "./policy.ts";
import type { Store } from "./store.ts";
import { appDetail, kpis, portfolio, releaseDetail } from "./views.ts";
import { OfflineWingman } from "./wingman.ts";

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const bad = (m: string) => new HttpError(400, m);
const forbidden = (m: string) => new HttpError(403, m);
const notFound = () => new HttpError(404, "Not found.");

const ROLE_KEYS = ROLES.map((r) => r.key) as string[];
const CAT_KEYS = CATEGORIES.map((c) => c.key) as string[];
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A GitLab project path: 2 to 10 segments of letters, digits, dot, underscore or hyphen. */
export const isProjectPath = (p: string) => { const parts = p.split("/"); return parts.length >= 2 && parts.length <= 10 && parts.every((x) => SEGMENT_RE.test(x)); };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v: unknown, name: string, max: number, required = true): string => {
  if (v == null || v === "") { if (required) throw bad(`${name} is required.`); return ""; }
  if (typeof v !== "string") throw bad(`${name} must be text.`);
  const s = v.trim();
  if (s.length > max) throw bad(`${name} is too long (max ${max}).`);
  return s;
};
const strList = (v: unknown, name: string, allowed?: string[]): string[] => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw bad(`${name} must be a list.`);
  const out = [...new Set(v.map((x: string) => x.trim()).filter(Boolean))];
  if (allowed) for (const x of out) if (!allowed.includes(x)) throw bad(`${name}: unknown value "${x}".`);
  return out;
};

/** Validates an application registration or edit. */
export function parseApp(body: any, partial = false): Partial<AppRecord> {
  const out: Partial<AppRecord> = {};
  const has = (k: string) => !partial || k in body;
  if (has("name")) out.name = str(body.name, "Name", 120);
  if (has("program")) out.program = str(body.program, "Program", 120, false);
  if (has("description")) out.description = str(body.description, "Description", 1000, false);
  if (has("gitlabProject")) {
    let p = str(body.gitlabProject, "GitLab project", 255);
    while (p.startsWith("/")) p = p.slice(1);
    while (p.endsWith("/")) p = p.slice(0, -1);
    if (!isProjectPath(p)) throw bad("GitLab project must be a path like group/project (no URL, no spaces).");
    out.gitlabProject = p;
  }
  if (has("defaultBranch")) out.defaultBranch = str(body.defaultBranch, "Default branch", 120, false) || "main";
  if (has("environments")) out.environments = strList(body.environments, "Environments").slice(0, 10);
  if (has("requiredRoles")) {
    out.requiredRoles = strList(body.requiredRoles, "Required roles", ROLE_KEYS) as RoleKey[];
    if (!partial && !out.requiredRoles.length) throw bad("Choose at least one required sign-off role.");
  }
  if (has("reviewers")) {
    const r = body.reviewers ?? {};
    if (typeof r !== "object" || Array.isArray(r)) throw bad("Reviewers must map roles to email lists.");
    const rev: AppRecord["reviewers"] = {};
    for (const [k, v] of Object.entries(r)) {
      if (!ROLE_KEYS.includes(k)) throw bad(`Reviewers: unknown role "${k}".`);
      const emails = strList(v, `Reviewers for ${k}`).map((e) => e.toLowerCase());
      for (const e of emails) if (!EMAIL_RE.test(e)) throw bad(`Reviewers: "${e}" is not an email address.`);
      rev[k as RoleKey] = emails.slice(0, 20);
    }
    out.reviewers = rev;
  }
  if (has("blockOn")) out.blockOn = strList(body.blockOn ?? ["Critical", "High"], "Block on", SEVERITIES as unknown as string[]) as Severity[];
  if (has("requiredScans")) out.requiredScans = strList(body.requiredScans ?? ["sast", "secrets", "sbom"], "Required scans", CAT_KEYS) as CategoryKey[];
  if (has("owner")) {
    const o = str(body.owner, "Owner", 254, false).toLowerCase();
    if (o && !EMAIL_RE.test(o)) throw bad("Owner must be an email address.");
    out.owner = o;
  }
  return out;
}

export interface UiConfig { classification: string; gitlabUrl: string | null; demo: boolean }

export function apiRouter(deps: { store: Store; gitlab: GitLab | null; publicUrl?: string; ui?: UiConfig }) {
  const { store, gitlab } = deps;
  const wingman = new OfflineWingman(store);
  const r = Router();
  const actor = (req: Request) => req.actor as Actor;
  const h = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    try { await fn(req, res); } catch (e) {
      if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return; }
      if (e instanceof Error && /already registered/.test(e.message)) { res.status(409).json({ error: e.message }); return; }
      console.error("[api]", e);
      res.status(500).json({ error: "Something went wrong; nothing was changed." });
    }
  };
  const canManage = (a: Actor, app: AppRecord) => isAdmin(a) || (!!a.email && a.email === app.owner);

  r.get("/me", h(async (req, res) => { res.json({ ...me(actor(req)), config: deps.ui ?? { classification: "", gitlabUrl: null, demo: false } }); }));

  r.get("/portfolio", h(async (_req, res) => {
    const apps = await portfolio(store);
    res.json({ apps, kpis: kpis(apps, await store.listReleases()), gitlabConfigured: !!gitlab });
  }));

  // ---------- applications ----------
  r.get("/apps/:id", h(async (req, res) => {
    const d = await appDetail(store, String(req.params.id));
    if (!d) throw notFound();
    res.json({ ...d, canManage: canManage(actor(req), d.app) });
  }));
  r.post("/apps", h(async (req, res) => {
    const a = actor(req);
    if (!isAdmin(a)) throw forbidden("Only Release Forge admins can register applications.");
    const p = parseApp(req.body ?? {});
    const app = await store.createApp({
      name: p.name!, program: p.program ?? "", description: p.description ?? "", gitlabProject: p.gitlabProject!, defaultBranch: p.defaultBranch ?? "main",
      environments: p.environments ?? [], requiredRoles: p.requiredRoles!, reviewers: p.reviewers ?? {}, blockOn: p.blockOn ?? ["Critical", "High"],
      requiredScans: p.requiredScans ?? ["sast", "secrets", "sbom"], owner: p.owner ?? "", createdBy: a.email ?? a.id,
    });
    await store.audit({ actor: a.email ?? a.id, action: "app.registered", appId: app.id, releaseId: null, detail: { gitlabProject: app.gitlabProject } });
    res.status(201).json(app);
  }));
  r.put("/apps/:id", h(async (req, res) => {
    const a = actor(req);
    const app = await store.getApp(String(req.params.id));
    if (!app) throw notFound();
    if (!canManage(a, app)) throw forbidden("Only admins and the application owner can change it.");
    const patch = parseApp(req.body ?? {}, true);
    // Owners manage their app's details and reviewers; only admins change policy or the project it points at.
    if (!isAdmin(a)) for (const k of ["gitlabProject", "blockOn", "requiredScans", "requiredRoles", "owner"] as const) if (k in patch) throw forbidden(`Only admins can change ${k}.`);
    const updated = await store.updateApp(app.id, patch);
    await store.audit({ actor: a.email ?? a.id, action: "app.updated", appId: app.id, releaseId: null, detail: { fields: Object.keys(patch) } });
    res.json(updated);
  }));
  r.post("/apps/:id/poll", h(async (req, res) => {
    const a = actor(req);
    const app = await store.getApp(String(req.params.id));
    if (!app) throw notFound();
    if (!canManage(a, app)) throw forbidden("Only admins and the application owner can poll.");
    if (!gitlab) throw new HttpError(503, "GitLab is not configured (GITLAB_URL and GITLAB_TOKEN).");
    res.json(await pollApp(store, gitlab, app));
  }));

  // ---------- releases ----------
  r.get("/releases/:id", h(async (req, res) => {
    const d = await releaseDetail(store, String(req.params.id));
    if (!d) throw notFound();
    const a = actor(req);
    res.json({
      ...d,
      mySignRoles: d.app.requiredRoles.filter((role) => canSign(d.app, role, a.email)),
      mySignedRole: d.signoffs.find((x) => x.sha === d.release.sha && x.reviewer === a.email)?.role ?? null,
      iAmAuthor: isAuthor(d.release, a),
      canAcceptRisk: canSign(d.app, "issm", a.email),
      canMarkFalsePositive: canSign(d.app, "issm", a.email) || canSign(d.app, "architect", a.email),
      canManage: canManage(a, d.app),
    });
  }));
  r.put("/releases/:id", h(async (req, res) => {
    const a = actor(req);
    const rel = await store.getRelease(String(req.params.id));
    if (!rel) throw notFound();
    const app = (await store.getApp(rel.appId))!;
    if (!canManage(a, app)) throw forbidden("Only admins and the application owner can change the target date.");
    const t = req.body?.targetDate;
    if (t !== null && (typeof t !== "string" || !DATE_RE.test(t))) throw bad("targetDate must be YYYY-MM-DD or null.");
    const updated = await store.updateRelease(rel.id, { targetDate: t });
    await store.audit({ actor: a.email ?? a.id, action: "release.target_date", appId: app.id, releaseId: rel.id, detail: { targetDate: t } });
    res.json(updated);
  }));
  r.post("/releases/:id/signoffs", h(async (req, res) => {
    const a = actor(req);
    const d = await releaseDetail(store, String(req.params.id));
    if (!d) throw notFound();
    const role = str(req.body?.role, "Role", 40) as RoleKey;
    const decision = req.body?.decision;
    const comment = str(req.body?.comment, "Comment", 2000, decision === "rejected");
    if (!d.app.requiredRoles.includes(role)) throw bad("That role is not required for this application.");
    if (decision !== "approved" && decision !== "rejected") throw bad("Decision must be approved or rejected.");
    if (!canSign(d.app, role, a.email)) throw forbidden(`You are not a listed reviewer for ${ROLES.find((x) => x.key === role)?.label}.`);
    if (isAuthor(d.release, a)) throw forbidden("You pushed this commit, so you can't sign it off (separation of duties).");
    const s = d.release.readiness.status;
    if (["superseded", "deployed", "scanning", "scan_failed"].includes(s)) throw bad(`This release is ${s.replace("_", " ")}; it can't be signed.`);
    if (decision === "approved" && s === "in_remediation") throw bad("Blocking findings are still open; approve after they are fixed or risk-accepted.");
    // Separation of duties: one person signs one role per release.
    const other = d.signoffs.find((x) => x.sha === d.release.sha && x.reviewer === a.email && x.role !== role);
    if (other) throw forbidden(`You already signed this release as ${ROLES.find((x) => x.key === other.role)?.label}; each role needs a different person.`);
    const so = await store.addSignoff({ releaseId: d.release.id, sha: d.release.sha, role, reviewer: a.email!, decision, comment, at: new Date().toISOString() });
    await store.audit({ actor: a.email!, action: `signoff.${decision}`, appId: d.app.id, releaseId: d.release.id, detail: { role, sha: d.release.sha, comment } });
    res.status(201).json(so);
  }));

  // ---------- findings ----------
  r.post("/findings/:id/state", h(async (req, res) => {
    const a = actor(req);
    const f = await store.getFinding(String(req.params.id));
    if (!f) throw notFound();
    const rel = (await store.getRelease(f.releaseId))!;
    const app = (await store.getApp(rel.appId))!;
    const state = req.body?.state;
    const note = str(req.body?.note, "Reason", 2000, state !== "open");
    if (state === "accepted" && !canSign(app, "issm", a.email)) throw forbidden("Only the application's Cyber ISSM can accept risk.");
    if (state === "false_positive" && !(canSign(app, "issm", a.email) || canSign(app, "architect", a.email))) throw forbidden("Only the Cyber ISSM or Solution Architect can mark a false positive.");
    if (state === "open" && !(canSign(app, "issm", a.email) || isAdmin(a))) throw forbidden("Only the Cyber ISSM or an admin can reopen a finding.");
    if (!["accepted", "false_positive", "open"].includes(state)) throw bad("State must be accepted, false_positive or open.");
    if (state !== "open" && note.length < 10) throw bad("Give a reason of at least 10 characters; it goes in the audit trail.");
    const updated = await store.setFindingState(f.id, state, a.email!, note);
    await store.audit({ actor: a.email!, action: `finding.${state}`, appId: app.id, releaseId: rel.id, detail: { findingId: f.id, fingerprint: f.fingerprint, severity: f.severity, title: f.title, note } });
    res.json(updated);
  }));

  r.get("/audit", h(async (req, res) => {
    const appId = typeof req.query.appId === "string" ? req.query.appId : undefined;
    res.json(await store.listAudit({ appId, limit: 300 }));
  }));

  // ---------- SI Wingman (offline) ----------
  r.post("/wingman", rateLimit(30), h(async (req, res) => {
    const prompt = str(req.body?.prompt, "Prompt", 500);
    const opt = (k: string) => (typeof req.body?.[k] === "string" ? req.body[k].slice(0, 64) : undefined);
    res.json(await wingman.ask({ prompt, appId: opt("appId"), releaseId: opt("releaseId"), findingId: opt("findingId") }, actor(req)));
  }));

  // ---------- deploy gate (called from GitLab CI as a service principal) ----------
  const gateTarget = async (req: Request) => {
    const project = str(req.body?.project, "project", 255);
    const sha = str(req.body?.sha, "sha", 64);
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw bad("sha must be a commit hash.");
    const app = await store.getAppByProject(project);
    if (!app) throw new HttpError(404, `GitLab project ${project} is not registered in Release Forge.`);
    return { app, sha: sha.toLowerCase() };
  };
  r.post("/gate/check", rateLimit(60), h(async (req, res) => {
    const { app, sha } = await gateTarget(req);
    let rel = await store.getReleaseBySha(app.id, sha);
    const pid = Number(req.body?.pipelineId);
    // The gate usually runs right after the scans: fetch this pipeline now rather than wait for the next poll.
    if (gitlab && Number.isInteger(pid) && pid > 0 && (!rel || !rel.scannedAt || pid > (rel.pipelineId ?? 0))) {
      await ingestPipeline(store, gitlab, app, pid);
      rel = await store.getReleaseBySha(app.id, sha);
    }
    if (!rel) { res.json({ allowed: false, status: "unknown", reasons: ["Release Forge has not seen this commit. Is the scan template included and the pipeline finished?"] }); return; }
    const d = (await releaseDetail(store, rel.id))!;
    const url = deps.publicUrl ? `${deps.publicUrl.replace(/\/$/, "")}/#/releases/${rel.id}` : null;
    await store.audit({ actor: actor(req).email ?? actor(req).id, action: d.release.readiness.allowed ? "gate.allowed" : "gate.denied", appId: app.id, releaseId: rel.id, detail: { sha, pipelineId: pid || null, reasons: d.release.readiness.reasons } });
    res.json({ allowed: d.release.readiness.allowed, status: d.release.readiness.status, reasons: d.release.readiness.reasons, release: rel.version, url });
  }));
  r.post("/gate/deployed", rateLimit(60), h(async (req, res) => {
    const a = actor(req);
    if (!isGatePrincipal(a)) throw forbidden("This principal may not record deployments (RF_GATE_PRINCIPALS).");
    const { app, sha } = await gateTarget(req);
    const environment = str(req.body?.environment, "environment", 60, false) || "production";
    const rel = await store.getReleaseBySha(app.id, sha);
    if (!rel) throw notFound();
    const d = (await releaseDetail(store, rel.id))!;
    if (!d.release.readiness.allowed) throw new HttpError(409, `Release is not approved: ${d.release.readiness.reasons.join(" ")}`);
    await store.updateRelease(rel.id, { deployedAt: new Date().toISOString(), deployedTo: environment });
    await store.audit({ actor: a.email ?? a.id, action: "release.deployed", appId: app.id, releaseId: rel.id, detail: { sha, environment } });
    res.json({ ok: true });
  }));

  return r;
}
