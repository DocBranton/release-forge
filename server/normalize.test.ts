import assert from "node:assert/strict";
import { test } from "node:test";
import { fromBundle, fromClamav, fromGitleaks, fromNpmAudit, fromSemgrep, normalizeAll } from "./normalize.ts";

const semgrep = JSON.stringify({
  results: [
    { check_id: "javascript.express.security.audit.sqli.tainted-sql", path: "server/q.ts", start: { line: 42 }, extra: { severity: "ERROR", message: "SQL built from input", metadata: { category: "security", owasp: ["A03:2021 - Injection"], cwe: ["CWE-89"] } } },
    { check_id: "javascript.lang.security.detect-eval", path: "server/e.ts", start: { line: 3 }, extra: { severity: "WARNING", message: "eval", metadata: { category: "security", impact: "HIGH" } } },
    { check_id: "typescript.react.i18n.jsx-not-internationalized", path: "client/a.tsx", start: { line: 1 }, extra: { severity: "INFO", message: "i18n", metadata: { category: "portability" } } },
  ],
  errors: [{ message: "x" }],
});

test("semgrep: security rules only, OWASP-tagged ones go to the OWASP category, impact beats severity", () => {
  const r = fromSemgrep(semgrep);
  assert.equal(r.findings.length, 2);
  const [sqli, evalF] = r.findings;
  assert.equal(sqli.category, "owasp");
  assert.equal(sqli.severity, "High");
  assert.match(sqli.title, /^Injection:/);
  assert.equal(evalF.category, "sast");
  assert.equal(evalF.severity, "High");
  assert.equal(r.errors, 1);
});

test("gitleaks: every leak is critical and the secret value is never kept", () => {
  const r = fromGitleaks(JSON.stringify([{ RuleID: "aws-access-token", Description: "AWS key", File: "a.py", StartLine: 3, Commit: "abcdef1234", Secret: "AKIAREALSECRET", Match: "key=AKIAREALSECRET" }]));
  assert.equal(r.findings[0].severity, "Critical");
  assert.equal(r.findings[0].path, "a.py @ abcdef12");
  assert.ok(!JSON.stringify(r).includes("AKIAREALSECRET"));
});

test("npm audit: one finding per package that carries an advisory, with a concrete fix", () => {
  const r = fromNpmAudit(JSON.stringify({ vulnerabilities: {
    express: { severity: "moderate", via: ["qs"], range: "4.x", fixAvailable: true },
    qs: { severity: "high", via: [{ title: "qs DoS", url: "https://github.com/advisories/GHSA-4mjr-xmp4-gh2g" }], range: "<6.16.0", fixAvailable: { name: "express", version: "5.3.0", isSemVerMajor: true } },
  } }));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, "GHSA-4mjr-xmp4-gh2g");
  assert.equal(r.findings[0].severity, "High");
  assert.match(r.findings[0].recommendation, /express to 5\.3\.0 \(major version change\)/);
});

test("npm audit: rf_skipped marks the category skipped", () => {
  const n = normalizeAll({ npmAudit: JSON.stringify({ rf_skipped: "no package-lock.json" }) });
  assert.deepEqual(n.categories.find((c) => c.key === "sbom")?.status, "skipped");
});

test("clamav: FOUND lines are critical; a log without a scan summary is an error", () => {
  const r = fromClamav("./bad.exe: Win.Test.EICAR_HDB-1 FOUND\n\n----------- SCAN SUMMARY -----------\nScanned files: 12\nInfected files: 1\n");
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].path, "bad.exe");
  assert.equal(r.scanned, 12);
  assert.throws(() => fromClamav("freshclam failed"));
});

test("bundle: non-zero exit is a high finding; warnings are low", () => {
  const r = fromBundle("Warning: unknown field foo\nError: resource app not found\nRF_EXIT=1\n");
  assert.deepEqual(r.findings.map((f) => f.severity), ["High", "Low"]);
  assert.equal(fromBundle("Validation OK!\nRF_EXIT=0").findings.length, 0);
  assert.equal(normalizeAll({ bundle: "RF_SKIPPED: no databricks.yml" }).categories.find((c) => c.key === "bundle")?.status, "skipped");
});

test("normalizeAll: missing files are skipped, unreadable files are errors, results are deduplicated", () => {
  const n = normalizeAll({ semgrep, gitleaks: "not json", checkov: JSON.stringify({ check_type: "gitlab_ci", summary: { passed: 5 }, results: { failed_checks: [] } }) });
  const st = Object.fromEntries(n.categories.map((c) => [c.key, c.status]));
  assert.equal(st.sast, "findings");
  assert.equal(st.owasp, "findings");
  assert.equal(st.secrets, "error");
  assert.equal(st.iac, "pass");
  assert.equal(st.sbom, "skipped");
  assert.equal(st.malware, "skipped");
  assert.equal(n.categories.find((c) => c.key === "iac")?.note, "5 checks passed");
  const twice = normalizeAll({ semgrep: JSON.stringify({ results: [...JSON.parse(semgrep).results, JSON.parse(semgrep).results[0]] }) });
  assert.equal(twice.findings.length, 2);
});

test("semgrep: a config failure (valid JSON, empty results, fatal error) is an error, not a pass", () => {
  // Shape copied from a real semgrep 1.182.1 run with a missing rules path.
  const failed = JSON.stringify({ version: "1.182.1", results: [], errors: [
    { code: 2, level: "error", type: "SemgrepError", message: "WARNING: unable to find a config; path `rules/javascript` does not exist" },
    { code: 7, level: "error", type: "SemgrepError", message: "invalid configuration file found (2 configs were invalid)" },
  ] });
  const n = normalizeAll({ semgrep: failed });
  assert.equal(n.categories.find((c) => c.key === "sast")?.status, "error");
  assert.match(n.categories.find((c) => c.key === "sast")?.note ?? "", /Semgrep did not run/);
  // Parse errors on individual files are not fatal.
  const partial = JSON.stringify({ results: [], errors: [{ level: "error", type: ["PartialParsing", []], message: "x" }, { level: "warn", type: "Syntax error", message: "y" }] });
  assert.equal(normalizeAll({ semgrep: partial }).categories.find((c) => c.key === "sast")?.status, "pass");
});

test("checkov: the empty summary it prints when nothing is scannable is a pass", () => {
  const n = normalizeAll({ checkov: JSON.stringify({ passed: 0, failed: 0, skipped: 0, parsing_errors: 0, resource_count: 0, checkov_version: "3.3.30" }) });
  assert.equal(n.categories.find((c) => c.key === "iac")?.status, "pass");
});
