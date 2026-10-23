// Demo data for local development only (RF_SEED_DEMO=1, never in production).
// Idea Forge II's findings come from the real assessment of commit ccde4dd on 2026-10-23;
// the other applications are illustrative and say so in their descriptions.
import type { CategoryResult, RoleKey } from "../shared/types.ts";
import type { NewFinding } from "./normalize.ts";
import type { Store } from "./store.ts";

const ALL_ROLES: RoleKey[] = ["pm", "architect", "functional", "config", "test", "issm"];
const cats = (over: Partial<Record<string, Partial<CategoryResult>>>): CategoryResult[] =>
  (["bundle", "sast", "sbom", "secrets", "owasp", "iac", "malware"] as const).map((key) => ({ key, status: "pass", note: "", counts: {}, ...(over[key] ?? {}) }) as CategoryResult);
const f = (category: NewFinding["category"], severity: NewFinding["severity"], tool: string, rule: string, title: string, path: string, recommendation: string, line: number | null = null): NewFinding =>
  ({ fingerprint: `${tool}:${rule}:${path}`, category, severity, tool, rule, title, path, line, recommendation });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

export async function seedDemo(store: Store, me: string) {
  if ((await store.listApps()).length) return;
  const reviewers = Object.fromEntries(ALL_ROLES.map((r) => [r, [me, `${r}.reviewer@example.mil`]]));

  // ---- Idea Forge II: real findings ----
  const forge = await store.createApp({
    name: "Idea Forge II", program: "RSO / AMPO", description: "Idea-to-capability workflow with SI Wingman, CAD and slicing.",
    gitlabProject: "drbranton-group/idea-forge-ii", defaultBranch: "main", environments: ["DEV", "PROD"], requiredRoles: ALL_ROLES, reviewers,
    blockOn: ["Critical", "High"], requiredScans: ["sast", "secrets", "sbom"], owner: me, createdBy: me,
  });
  const forgeRel = await store.upsertRelease(forge.id, { sha: "ccde4ddeb180376ec706c0fd049a0bc89f5500e8", ref: "main", isTag: false, pipelineId: 2964589971, pipelineUrl: null, author: "drbranton", createdAt: ago(2) });
  await store.recordScan(forgeRel.id, cats({ sast: { status: "findings", note: "11 rule hits, 0 confirmed; sandbox issue found in review" }, sbom: { status: "findings" }, owasp: { status: "findings" }, iac: { note: "73 checks passed" }, bundle: { note: "Layout check passed" }, malware: { note: "OCCT binaries verified against npm 0.0.23" } }), [
    f("sbom", "High", "npm audit", "GHSA-4mjr-xmp4-gh2g", "qs: denial of service via attacker-controlled isBuffer (through express in @databricks/appkit)", "package-lock.json (qs 2.2.5 - 6.15.3)", "Add an npm override: qs >= 6.16.0."),
    f("sbom", "High", "npm audit", "GHSA-45rx-2jwx-cxfr", "@opentelemetry/propagator-jaeger: denial of service on a malformed header", "package-lock.json (@opentelemetry/propagator-jaeger <2.9.0)", "Add an npm override: @opentelemetry/propagator-jaeger >= 2.9.0."),
    f("sast", "Medium", "Manual review", "sandbox-computed-property", "Draft-CAD sandbox static check bypassed with string-built property names", "server/draft/sandbox.ts", "Reject computed member access unless the index is numeric; run the runner in an isolated job with no egress."),
    f("owasp", "Medium", "Manual review", "A05-missing-security-headers", "Security Misconfiguration: no Content-Security-Policy or other security headers", "server/server.ts", "Add CSP, nosniff and Referrer-Policy headers."),
    f("owasp", "Medium", "Manual review", "A04-no-rate-limit", "Insecure Design: no per-user rate limits on model routes", "server/wingman-route.ts", "Add per-user rate limits on the Wingman, assist, vision and draft routes."),
    f("owasp", "Medium", "Manual review", "A01-admin-bootstrap", "Broken Access Control: first project owner becomes admin when APP_ADMINS is unset", "server/notify.ts", "Set APP_ADMINS in app.yaml before first use.", 47),
    f("sbom", "Low", "npm audit", "GHSA-55q2-fjhq-7xh7", "dompurify (unused, via @databricks/appkit-ui): XSS advisories", "package-lock.json (dompurify <=3.4.16)", "Remove @databricks/appkit-ui; nothing imports it."),
    f("owasp", "Low", "Manual review", "A03-content-disposition", "Injection: download filename quotes not escaped", "server/project-routes.ts", "Escape double quotes in the Content-Disposition filename.", 137),
  ], ago(2));
  await store.updateRelease(forgeRel.id, { targetDate: day(18) });

  // ---- illustrative applications ----
  const demo = async (name: string, project: string, desc: string, opts: { findings: NewFinding[]; target: number; signed: RoleKey[]; createdDaysAgo: number; deployed?: boolean }) => {
    const app = await store.createApp({
      name, program: "RSO", description: `${desc} (Demo data.)`, gitlabProject: project, defaultBranch: "main", environments: ["DEV", "TEST", "PROD"],
      requiredRoles: ALL_ROLES, reviewers, blockOn: ["Critical", "High"], requiredScans: ["sast", "secrets", "sbom"], owner: me, createdBy: me,
    });
    const sha = Buffer.from(name).toString("hex").padEnd(40, "0").slice(0, 40);
    const rel = await store.upsertRelease(app.id, { sha, ref: "v0.9." + (name.length % 9), isTag: true, pipelineId: 1000 + name.length, pipelineUrl: null, author: "builder", createdAt: ago(opts.createdDaysAgo) });
    await store.recordScan(rel.id, cats({}), opts.findings, ago(opts.createdDaysAgo));
    await store.updateRelease(rel.id, { targetDate: day(opts.target), ...(opts.deployed ? { deployedAt: ago(1), deployedTo: "PROD" } : {}) });
    for (const role of opts.signed) {
      const reviewer = `${role}.reviewer@example.mil`;
      await store.addSignoff({ releaseId: rel.id, sha, role, reviewer, decision: "approved", comment: "Reviewed.", at: ago(Math.max(0, opts.createdDaysAgo - 1)) });
    }
  };
  await demo("SI CAD Workbench", "drbranton-group/cad-workbench", "SI-assisted parametric CAD in the browser.", {
    findings: [f("sbom", "Medium", "npm audit", "GHSA-demo-1", "Example: transitive dependency advisory", "package-lock.json", "Upgrade the parent package.")],
    target: 9, signed: ["pm", "architect", "functional"], createdDaysAgo: 10,
  });
  await demo("Mission Workbench", "rso/mission-workbench", "Engineering collaboration and AM enablement workbench.", {
    findings: [f("iac", "Low", "Checkov", "CKV_GITLABCI_1", "Example: pipeline image not pinned by digest", ".gitlab-ci.yml", "Pin the image by digest.")],
    target: 5, signed: ALL_ROLES, createdDaysAgo: 6,
  });
  await demo("Knowledge Base", "rso/knowledge-base", "Searchable engineering knowledge base.", {
    findings: [f("secrets", "Critical", "Gitleaks", "generic-api-key", "Example: possible API key in configuration", "config/settings.py", "Rotate and move to a Databricks secret.", 12)],
    target: -3, signed: [], createdDaysAgo: 14,
  });
  await demo("Deployment Insights", "rso/deployment-insights", "Deployment metrics across environments.", {
    findings: [], target: -1, signed: ALL_ROLES, createdDaysAgo: 4, deployed: true,
  });
}
