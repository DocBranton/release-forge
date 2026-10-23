// End to end through HTTP: register an app, ingest a pipeline from a fake GitLab, review, gate, deploy.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { buildApp } from "./app.ts";
import { GitLab } from "./gitlab.ts";
import { pollApp } from "./ingest.ts";
import { MemoryStore } from "./store.ts";

process.env.NODE_ENV = "test";
process.env.APP_ADMINS = "admin@x.mil";
process.env.RF_GATE_PRINCIPALS = "gate-sp";

const SHA1 = "1111111111111111111111111111111111111111";
const SHA2 = "2222222222222222222222222222222222222222";
const semgrep = JSON.stringify({ results: [{ check_id: "js.sqli.tainted-sql", path: "server/q.ts", start: { line: 9 }, extra: { severity: "ERROR", message: "SQL from input", metadata: { category: "security", cwe: ["CWE-89"] } } }] });
const pipelines: Record<number, any> = {
  12: { id: 12, sha: SHA1, ref: "main", status: "success", source: "push", web_url: "https://gl/p/12", created_at: "2026-10-20T10:00:00Z", user: { username: "dev1" } },
  13: { id: 13, sha: SHA2, ref: "v1.1.0", tag: true, status: "success", source: "push", web_url: "https://gl/p/13", created_at: "2026-10-21T10:00:00Z", user: { username: "dev1" } },
  14: { id: 14, sha: SHA2, ref: "main", status: "success", source: "schedule", created_at: "2026-10-21T11:00:00Z" },
};
let visible = [12];
const fakeFetch = (async (url: string) => {
  const u = new URL(url);
  const path = decodeURIComponent(u.pathname.replace("/api/v4/projects/", ""));
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  let m;
  if ((m = /^grp\/app\/pipelines$/.exec(path))) return json(visible.map((id) => pipelines[id]).sort((a, b) => b.id - a.id));
  if ((m = /^grp\/app\/pipelines\/(\d+)$/.exec(path))) return json(pipelines[Number(m[1])]);
  if ((m = /^grp\/app\/pipelines\/(\d+)\/jobs$/.exec(path))) return json([{ id: Number(m[1]) * 10 + 1, name: "rf-semgrep" }, { id: Number(m[1]) * 10 + 2, name: "rf-gitleaks" }, { id: Number(m[1]) * 10 + 3, name: "rf-npm-audit" }]);
  if ((m = /^grp\/app\/jobs\/(\d+)\/artifacts\/release-forge\/(.+)$/.exec(path))) {
    const file = m[2];
    if (file === "semgrep.json") return new Response(semgrep);
    if (file === "gitleaks.json") return new Response("[]");
    if (file === "npm-audit.json") return new Response(JSON.stringify({ vulnerabilities: {} }));
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const store = new MemoryStore();
const gitlab = new GitLab("https://gitlab.example", "token", fakeFetch);
let base = "";
let server: ReturnType<ReturnType<typeof buildApp>["listen"]>;
before(async () => { server = buildApp({ store, gitlab }).listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(() => server.close());

const as = (email: string, id = email) => ({ "x-forwarded-user": id, "x-forwarded-email": email, "content-type": "application/json" });
const call = async (method: string, path: string, who: Record<string, string>, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: who, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any, headers: r.headers };
};

let appId = "", releaseId = "";

test("requests without Databricks identity are refused; responses carry security headers", async () => {
  const r = await call("GET", "/api/me", {});
  assert.equal(r.status, 401);
  assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'self'/);
});

test("only admins register applications, and the project must be a path", async () => {
  const appBody = { name: "App", gitlabProject: "grp/app", requiredRoles: ["pm", "issm"], reviewers: { pm: ["pm@x.mil", "dev1@x.mil"], issm: ["issm@x.mil"] } };
  assert.equal((await call("POST", "/api/apps", as("pm@x.mil"), appBody)).status, 403);
  assert.equal((await call("POST", "/api/apps", as("admin@x.mil"), { ...appBody, gitlabProject: "https://evil.example/x" })).status, 400);
  const r = await call("POST", "/api/apps", as("admin@x.mil"), appBody);
  assert.equal(r.status, 201);
  appId = r.body.id;
  assert.equal((await call("POST", "/api/apps", as("admin@x.mil"), appBody)).status, 409);
});

test("gate check ingests the pipeline and denies while a high finding is open", async () => {
  const r = await call("POST", "/api/gate/check", as("gate-sp@x.mil", "gate-sp"), { project: "grp/app", sha: SHA1, pipelineId: 12 });
  assert.equal(r.status, 200);
  assert.equal(r.body.allowed, false);
  assert.equal(r.body.status, "in_remediation");
  releaseId = (await store.getReleaseBySha(appId, SHA1))!.id;
  const d = await call("GET", `/api/releases/${releaseId}`, as("issm@x.mil"));
  assert.equal(d.body.findings.length, 1);
  assert.equal(d.body.canAcceptRisk, true);
});

test("approval is refused while blocking findings are open; only the ISSM can accept risk", async () => {
  assert.equal((await call("POST", `/api/releases/${releaseId}/signoffs`, as("pm@x.mil"), { role: "pm", decision: "approved" })).status, 400);
  const fid = (await store.listFindings([releaseId]))[0].id;
  assert.equal((await call("POST", `/api/findings/${fid}/state`, as("pm@x.mil"), { state: "accepted", note: "Compensating control in place" })).status, 403);
  assert.equal((await call("POST", `/api/findings/${fid}/state`, as("issm@x.mil"), { state: "accepted", note: "short" })).status, 400);
  assert.equal((await call("POST", `/api/findings/${fid}/state`, as("issm@x.mil"), { state: "accepted", note: "Input is a fixed enum; tracked as POA&M-12" })).status, 200);
});

test("the commit author can't sign; listed reviewers can; then the gate allows and records the deploy", async () => {
  const self = await call("POST", `/api/releases/${releaseId}/signoffs`, as("dev1@x.mil"), { role: "pm", decision: "approved" });
  assert.equal(self.status, 403);
  assert.match(self.body.error, /separation of duties/);
  assert.equal((await call("POST", `/api/releases/${releaseId}/signoffs`, as("issm@x.mil"), { role: "pm", decision: "approved" })).status, 403);
  assert.equal((await call("POST", `/api/releases/${releaseId}/signoffs`, as("pm@x.mil"), { role: "pm", decision: "approved" })).status, 201);
  // pm@x.mil is also listed for another role on this app but may only sign one role per release.
  await store.updateApp(appId, { reviewers: { pm: ["pm@x.mil", "dev1@x.mil"], issm: ["issm@x.mil", "pm@x.mil"] } });
  const twice = await call("POST", `/api/releases/${releaseId}/signoffs`, as("pm@x.mil"), { role: "issm", decision: "approved" });
  assert.equal(twice.status, 403);
  assert.match(twice.body.error, /each role needs a different person/);
  assert.equal((await call("POST", `/api/gate/check`, as("gate-sp@x.mil", "gate-sp"), { project: "grp/app", sha: SHA1 })).body.allowed, false);
  assert.equal((await call("POST", `/api/releases/${releaseId}/signoffs`, as("issm@x.mil"), { role: "issm", decision: "approved" })).status, 201);
  const ok = await call("POST", `/api/gate/check`, as("gate-sp@x.mil", "gate-sp"), { project: "grp/app", sha: SHA1 });
  assert.equal(ok.body.allowed, true);
  assert.equal((await call("POST", `/api/gate/deployed`, as("pm@x.mil"), { project: "grp/app", sha: SHA1 })).status, 403);
  assert.equal((await call("POST", `/api/gate/deployed`, as("gate-sp@x.mil", "gate-sp"), { project: "grp/app", sha: SHA1, environment: "PROD" })).status, 200);
  assert.equal((await store.getRelease(releaseId))!.deployedTo, "PROD");
});

test("polling picks up a new tag, ignores schedules, carries the accepted risk forward and resets sign-off", async () => {
  visible = [12, 13, 14];
  const r = await pollApp(store, gitlab, (await store.getApp(appId))!);
  assert.equal(r.ingested, 1);
  const rel2 = (await store.getReleaseBySha(appId, SHA2))!;
  assert.equal(rel2.version, "v1.1.0");
  const f2 = await store.listFindings([rel2.id]);
  assert.equal(f2[0].state, "accepted");
  const d = await call("GET", `/api/releases/${rel2.id}`, as("pm@x.mil"));
  assert.equal(d.body.release.readiness.status, "in_review");
  assert.deepEqual(d.body.release.readiness.missingRoles, ["pm", "issm"]);
  // The deployed release stays deployed, not superseded.
  assert.equal((await store.getRelease(releaseId))!.supersededBy, null);
});

test("wingman answers offline from data and explains a finding", async () => {
  const s = await call("POST", "/api/wingman", as("pm@x.mil"), { prompt: "What needs my sign-off?" });
  assert.equal(s.body.source, "offline");
  assert.match(s.body.title, /1 sign-off waiting on you/);
  const fid = (await store.listFindings([(await store.getReleaseBySha(appId, SHA2))!.id]))[0].id;
  const g = await call("POST", "/api/wingman", as("pm@x.mil"), { prompt: "how do I fix this", findingId: fid });
  assert.match(JSON.stringify(g.body), /parameterized/);
});

test("every decision is in the audit trail", async () => {
  const a = await call("GET", `/api/audit?appId=${appId}`, as("pm@x.mil"));
  const actions = a.body.map((e: any) => e.action);
  for (const x of ["app.registered", "scan.ingested", "finding.accepted", "signoff.approved", "gate.denied", "gate.allowed", "release.deployed"]) assert.ok(actions.includes(x), x);
});
