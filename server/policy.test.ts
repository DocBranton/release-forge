import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppRecord, Finding, ReleaseRecord, SignOff } from "../shared/types.ts";
import { canSign, isAuthor, readiness } from "./policy.ts";

const app: AppRecord = {
  id: "app_1", name: "A", program: "", description: "", gitlabProject: "g/a", defaultBranch: "main", environments: [],
  requiredRoles: ["pm", "issm"], reviewers: { pm: ["pm@x.mil"], issm: ["issm@x.mil"] }, blockOn: ["Critical", "High"],
  requiredScans: ["sast", "secrets"], owner: "", createdAt: "", createdBy: "",
};
const passCats = (["sast", "secrets", "sbom"] as const).map((key) => ({ key, status: "pass" as const, note: "", counts: {} }));
const rel = (over: Partial<ReleaseRecord> = {}): ReleaseRecord => ({
  id: "rel_1", appId: "app_1", version: "v1", sha: "aaaa1111", ref: "v1", isTag: true, pipelineId: 1, pipelineUrl: null, author: "dev1",
  createdAt: "2026-10-01T00:00:00Z", scannedAt: "2026-10-01T01:00:00Z", targetDate: null, deployedAt: null, deployedTo: null, categories: passCats, supersededBy: null, ...over,
});
const finding = (severity: Finding["severity"], state: Finding["state"] = "open"): Finding => ({
  id: "f" + Math.random(), releaseId: "rel_1", fingerprint: "fp", category: "sast", severity, tool: "t", rule: "r", title: "t", path: "p", line: null, recommendation: "", state, stateBy: null, stateNote: null, stateAt: null,
});
const so = (role: SignOff["role"], decision: SignOff["decision"], sha = "aaaa1111", at = "2026-10-02T00:00:00Z"): SignOff => ({ id: "s" + Math.random(), releaseId: "rel_1", sha, role, reviewer: `${role}@x.mil`, decision, comment: "c", at });

test("not scanned yet: scanning, not allowed", () => {
  const r = readiness(app, rel({ scannedAt: null }), [], []);
  assert.equal(r.status, "scanning");
  assert.equal(r.allowed, false);
});

test("open high finding blocks; accepting the risk unblocks", () => {
  assert.equal(readiness(app, rel(), [finding("High")], [so("pm", "approved"), so("issm", "approved")]).status, "in_remediation");
  const r = readiness(app, rel(), [finding("High", "accepted"), finding("Medium")], [so("pm", "approved"), so("issm", "approved")]);
  assert.equal(r.status, "approved");
  assert.equal(r.allowed, true);
});

test("a required scan that did not run blocks approval", () => {
  const cats = passCats.map((c) => (c.key === "secrets" ? { ...c, status: "skipped" as const } : c));
  const r = readiness(app, rel({ categories: cats }), [], [so("pm", "approved"), so("issm", "approved")]);
  assert.equal(r.status, "in_remediation");
  assert.match(r.reasons[0], /Secrets scan did not run/);
});

test("sign-offs for another commit do not count; the latest decision per role wins", () => {
  assert.deepEqual(readiness(app, rel(), [], [so("pm", "approved", "bbbb2222"), so("issm", "approved")]).missingRoles, ["pm"]);
  const r = readiness(app, rel(), [], [so("pm", "approved"), so("issm", "approved", "aaaa1111", "2026-10-02T00:00:00Z"), so("issm", "rejected", "aaaa1111", "2026-10-03T00:00:00Z")]);
  assert.equal(r.status, "in_review");
  assert.deepEqual(r.rejectedRoles, ["issm"]);
  assert.match(r.reasons[0], /Cyber ISSM rejected/);
});

test("superseded and deployed releases", () => {
  assert.equal(readiness(app, rel({ supersededBy: "rel_2" }), [], []).allowed, false);
  assert.equal(readiness(app, rel({ deployedAt: "2026-10-05T00:00:00Z" }), [], []).status, "deployed");
});

test("only listed reviewers can sign, and the commit author cannot", () => {
  assert.equal(canSign(app, "pm", "PM@x.mil"), true);
  assert.equal(canSign(app, "issm", "pm@x.mil"), false);
  assert.equal(isAuthor(rel(), { id: "u1", email: "dev1@x.mil" }), true);
  assert.equal(isAuthor(rel(), { id: "u2", email: "pm@x.mil" }), false);
});
