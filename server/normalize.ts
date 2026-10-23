// Turns raw scanner outputs (CI job artifacts) into Release Forge findings and per-category results.
// Each scanner's file is optional: a missing file means the category was skipped. A file that
// can't be parsed marks the category as errored rather than silently passing.
import { createHash } from "node:crypto";
import { CATEGORIES, SEVERITIES, type CategoryKey, type CategoryResult, type Finding, type Severity } from "../shared/types.ts";

export type NewFinding = Omit<Finding, "id" | "releaseId" | "state" | "stateBy" | "stateNote" | "stateAt">;

/** Artifact file names the CI template writes, relative to the job's artifacts root. */
export const ARTIFACT_FILES = {
  semgrep: "release-forge/semgrep.json",
  gitleaks: "release-forge/gitleaks.json",
  npmAudit: "release-forge/npm-audit.json",
  checkov: "release-forge/checkov.json",
  clamav: "release-forge/clamav.txt",
  bundle: "release-forge/bundle.txt",
} as const;
export type ArtifactKey = keyof typeof ARTIFACT_FILES;
export type RawArtifacts = Partial<Record<ArtifactKey, string | null>>;

const fp = (...parts: (string | number | null | undefined)[]) =>
  createHash("sha256").update(parts.map((p) => String(p ?? "")).join("\u0000")).digest("hex").slice(0, 24);
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

class Unparseable extends Error {}
function json(text: string): any {
  try { return JSON.parse(text); } catch { throw new Unparseable("not valid JSON"); }
}
/** CI writes {"rf_skipped": "reason"} when a scanner does not apply (e.g. no package-lock.json). */
function skipped(d: any): string | null {
  return d && typeof d === "object" && !Array.isArray(d) && typeof d.rf_skipped === "string" ? clip(d.rf_skipped, 200) : null;
}

// ---------- Semgrep ----------
const SEMGREP_SEV: Record<string, Severity> = { ERROR: "High", WARNING: "Medium", INFO: "Low", CRITICAL: "Critical", HIGH: "High", MEDIUM: "Medium", LOW: "Low" };

export function fromSemgrep(text: string): { findings: NewFinding[]; errors: number; skip?: string } {
  const d = json(text);
  const s = skipped(d);
  if (s) return { findings: [], errors: 0, skip: s };
  if (!d || !Array.isArray(d.results)) throw new Unparseable("missing results[]");
  // A config or rule failure still writes valid JSON with empty results; that is a failed scan, not a pass.
  const fatal = (Array.isArray(d.errors) ? d.errors : []).find((e: any) => e?.level === "error" && !/syntax|pars|timeout|toolarge|lexical/i.test(String(e?.type ?? "")));
  if (fatal && d.results.length === 0) throw new Unparseable(`Semgrep did not run: ${clip(fatal.message, 160)}`);
  const findings: NewFinding[] = [];
  for (const r of d.results) {
    const meta = r?.extra?.metadata ?? {};
    const owasp: string[] = Array.isArray(meta.owasp) ? meta.owasp : meta.owasp ? [String(meta.owasp)] : [];
    const security = meta.category === "security" || owasp.length > 0 || meta.cwe;
    if (!security) continue; // style and i18n rules are not security findings
    const impact = String(meta.impact ?? "").toUpperCase();
    const severity = SEMGREP_SEV[impact] ?? SEMGREP_SEV[String(r?.extra?.severity ?? "").toUpperCase()] ?? "Medium";
    const rule = clip(r.check_id, 200);
    const path = clip(r.path, 300);
    const line = Number.isInteger(r?.start?.line) ? r.start.line : null;
    const shortRule = rule.split(".").pop() ?? rule;
    findings.push({
      fingerprint: fp("semgrep", rule, path, line),
      category: owasp.length ? "owasp" : "sast",
      severity,
      tool: "Semgrep",
      rule,
      title: clip(owasp[0] ? `${owasp[0].split(" - ").pop()}: ${shortRule}` : clip(r?.extra?.message, 140) || shortRule, 200),
      path,
      line,
      recommendation: clip(r?.extra?.fix ? `Apply the suggested fix: ${r.extra.fix}` : r?.extra?.message ?? "Review the flagged code.", 500),
    });
  }
  return { findings, errors: Array.isArray(d.errors) ? d.errors.length : 0 };
}

// ---------- Gitleaks ----------
export function fromGitleaks(text: string): { findings: NewFinding[]; skip?: string } {
  const d = json(text);
  const s = skipped(d);
  if (s) return { findings: [], skip: s };
  if (!Array.isArray(d)) throw new Unparseable("expected an array");
  // The secret value itself is never read or stored.
  return {
    findings: d.map((g: any) => {
      const path = clip(g.File, 300);
      const line = Number.isInteger(g.StartLine) ? g.StartLine : null;
      return {
        fingerprint: fp("gitleaks", g.RuleID, path, g.Commit ?? "", line),
        category: "secrets" as const,
        severity: "Critical" as const,
        tool: "Gitleaks",
        rule: clip(g.RuleID, 120),
        title: clip(g.Description || `Possible secret (${g.RuleID})`, 200),
        path: g.Commit ? `${path} @ ${String(g.Commit).slice(0, 8)}` : path,
        line,
        recommendation: "Rotate the credential now, remove it from the code and history, and load it from a Databricks secret instead.",
      };
    }),
  };
}

// ---------- npm audit (v7+ JSON) ----------
const NPM_SEV: Record<string, Severity> = { critical: "Critical", high: "High", moderate: "Medium", low: "Low", info: "Info" };

export function fromNpmAudit(text: string): { findings: NewFinding[]; skip?: string } {
  const d = json(text);
  const s = skipped(d);
  if (s) return { findings: [], skip: s };
  if (!d || typeof d.vulnerabilities !== "object") throw new Unparseable("missing vulnerabilities");
  const findings: NewFinding[] = [];
  for (const [name, v] of Object.entries<any>(d.vulnerabilities)) {
    // Only packages that carry an advisory themselves; parents that merely depend on them are the same issue.
    const advisories = (Array.isArray(v.via) ? v.via : []).filter((x: any) => x && typeof x === "object");
    if (!advisories.length) continue;
    const ids = advisories.map((a: any) => String(a.url ?? "").split("/").pop()).filter(Boolean);
    const fix = v.fixAvailable;
    const recommendation = fix === true ? `Run npm audit fix, or upgrade ${name} out of ${v.range}.`
      : fix && typeof fix === "object" ? `Upgrade ${fix.name} to ${fix.version}${fix.isSemVerMajor ? " (major version change)" : ""}, or add an npm override for ${name}.`
      : `No fixed version yet; add an npm override when one is published, or remove ${name}.`;
    findings.push({
      fingerprint: fp("npm-audit", name, ids.sort().join(",")),
      category: "sbom",
      severity: NPM_SEV[v.severity] ?? "Medium",
      tool: "npm audit",
      rule: clip(ids.join(", ") || name, 200),
      title: clip(`${name}: ${advisories.map((a: any) => a.title).filter(Boolean).join("; ")}`, 200),
      path: `package-lock.json (${name} ${clip(v.range, 60)}${v.isDirect ? ", direct" : ""})`,
      line: null,
      recommendation,
    });
  }
  return { findings };
}

// ---------- Checkov ----------
const CHECKOV_SEV: Record<string, Severity> = { CRITICAL: "Critical", HIGH: "High", MEDIUM: "Medium", LOW: "Low", INFO: "Info" };

export function fromCheckov(text: string): { findings: NewFinding[]; passed: number; skip?: string } {
  const d = json(text);
  const s = skipped(d);
  if (s) return { findings: [], passed: 0, skip: s };
  const reports = Array.isArray(d) ? d : [d];
  // Checkov prints {"passed":0,"failed":0,...} with no "results" when nothing was scannable.
  if (!reports.every((r: any) => r && typeof r === "object")) throw new Unparseable("unexpected report shape");
  const findings: NewFinding[] = [];
  let passed = 0;
  for (const r of reports) {
    passed += Number(r?.summary?.passed ?? 0);
    for (const c of r?.results?.failed_checks ?? []) {
      const path = clip(String(c.file_path ?? "").replace(/^\//, ""), 300);
      const line = Array.isArray(c.file_line_range) && Number.isInteger(c.file_line_range[0]) ? c.file_line_range[0] : null;
      findings.push({
        fingerprint: fp("checkov", c.check_id, path, c.resource),
        category: "iac",
        severity: CHECKOV_SEV[String(c.severity ?? "").toUpperCase()] ?? "Medium",
        tool: "Checkov",
        rule: clip(c.check_id, 60),
        title: clip(c.check_name, 200),
        path,
        line,
        recommendation: clip(c.guideline ? `See ${c.guideline}` : `Fix ${c.check_id} in ${path}, or record a justified skip in .checkov.yaml.`, 500),
      });
    }
  }
  return { findings, passed };
}

// ---------- ClamAV (clamscan --infected output) ----------
export function fromClamav(text: string): { findings: NewFinding[]; scanned: number | null } {
  const findings: NewFinding[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(.+?):\s+(.+?)\s+FOUND$/.exec(line.trim());
    if (!m) continue;
    findings.push({
      fingerprint: fp("clamav", m[1], m[2]),
      category: "malware",
      severity: "Critical",
      tool: "ClamAV",
      rule: clip(m[2], 120),
      title: clip(`Malware signature: ${m[2]}`, 200),
      path: clip(m[1].replace(/^\.\//, ""), 300),
      line: null,
      recommendation: "Remove the file from the repository and its history, find how it got there, and rescan.",
    });
  }
  const scanned = /Scanned files:\s*(\d+)/.exec(text);
  if (!findings.length && !/SCAN SUMMARY/.test(text)) throw new Unparseable("no ClamAV scan summary");
  return { findings, scanned: scanned ? Number(scanned[1]) : null };
}

// ---------- databricks bundle validate (text, with a trailing RF_EXIT=<code>) ----------
export function fromBundle(text: string): { findings: NewFinding[]; ok: boolean; skip?: string } {
  const sk = /RF_SKIPPED:\s*(.+)/.exec(text);
  if (sk) return { findings: [], ok: true, skip: clip(sk[1], 200) };
  const exit = /RF_EXIT=(\d+)/.exec(text);
  if (!exit) throw new Unparseable("missing RF_EXIT line");
  const ok = exit[1] === "0";
  const findings: NewFinding[] = [];
  if (!ok) {
    const firstError = text.split(/\r?\n/).find((l) => /^Error:/i.test(l.trim())) ?? "databricks bundle validate failed";
    findings.push({
      fingerprint: fp("bundle", "validate-failed", firstError),
      category: "bundle", severity: "High", tool: "databricks bundle validate", rule: "bundle-validate",
      title: clip(firstError, 200), path: "databricks.yml", line: null,
      recommendation: "Fix the bundle configuration so `databricks bundle validate` passes.",
    });
  }
  for (const w of text.split(/\r?\n/).filter((l) => /^Warning:/i.test(l.trim())).slice(0, 20)) {
    findings.push({
      fingerprint: fp("bundle", "warning", w), category: "bundle", severity: "Low", tool: "databricks bundle validate", rule: "bundle-warning",
      title: clip(w, 200), path: "databricks.yml", line: null, recommendation: "Resolve the bundle warning.",
    });
  }
  return { findings, ok };
}

// ---------- all together ----------
function counts(findings: NewFinding[]): Partial<Record<Severity, number>> {
  const c: Partial<Record<Severity, number>> = {};
  for (const f of findings) c[f.severity] = (c[f.severity] ?? 0) + 1;
  return c;
}

export function normalizeAll(raw: RawArtifacts): { categories: CategoryResult[]; findings: NewFinding[] } {
  const findings: NewFinding[] = [];
  const result = new Map<CategoryKey, CategoryResult>();
  const set = (key: CategoryKey, status: CategoryResult["status"], note: string) => result.set(key, { key, status, note, counts: {} });
  const run = <T>(key: ArtifactKey, cats: CategoryKey[], fn: (text: string) => T, after: (r: T) => void) => {
    const text = raw[key];
    if (text == null) { for (const c of cats) if (!result.has(c)) set(c, "skipped", "No results from the pipeline (scan job missing or produced no artifact)."); return; }
    try { after(fn(text)); } catch (e) {
      for (const c of cats) set(c, "error", `Could not read ${ARTIFACT_FILES[key]}: ${(e as Error).message}`);
    }
  };

  run("semgrep", ["sast", "owasp"], fromSemgrep, (r) => {
    if (r.skip) { set("sast", "skipped", r.skip); set("owasp", "skipped", r.skip); return; }
    findings.push(...r.findings);
    const note = r.errors ? `${r.errors} file${r.errors > 1 ? "s" : ""} could not be parsed by Semgrep` : "";
    set("sast", "pass", note); set("owasp", "pass", note);
  });
  run("gitleaks", ["secrets"], fromGitleaks, (r) => { if (r.skip) set("secrets", "skipped", r.skip); else { findings.push(...r.findings); set("secrets", "pass", "Working tree and git history"); } });
  run("npmAudit", ["sbom"], fromNpmAudit, (r) => { if (r.skip) set("sbom", "skipped", r.skip); else { findings.push(...r.findings); set("sbom", "pass", "Production and development dependencies"); } });
  run("checkov", ["iac"], fromCheckov, (r) => { if (r.skip) set("iac", "skipped", r.skip); else { findings.push(...r.findings); set("iac", "pass", `${r.passed} checks passed`); } });
  run("clamav", ["malware"], fromClamav, (r) => { findings.push(...r.findings); set("malware", "pass", r.scanned != null ? `${r.scanned} files scanned` : ""); });
  run("bundle", ["bundle"], fromBundle, (r) => { if (r.skip) set("bundle", "skipped", r.skip); else { findings.push(...r.findings); set("bundle", "pass", r.ok ? "Bundle validates" : ""); } });

  // Same fingerprint twice in one scan (e.g. a rule matched by two packs) is one finding.
  const unique = [...new Map(findings.map((f) => [f.fingerprint, f])).values()];
  const categories = CATEGORIES.map(({ key }) => {
    const r = result.get(key) ?? { key, status: "skipped" as const, note: "", counts: {} };
    const mine = unique.filter((f) => f.category === key);
    const c = counts(mine);
    return { ...r, counts: c, status: r.status === "pass" && mine.length ? "findings" as const : r.status };
  });
  unique.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  return { categories, findings: unique };
}
