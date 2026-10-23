// Release readiness: one function decides it for the UI, the Wingman and the deploy gate.
import { CATEGORIES, ROLES, SEVERITIES, type AppRecord, type Finding, type Readiness, type ReleaseRecord, type RoleKey, type Severity, type SignOff } from "../shared/types.ts";

const roleLabel = (k: RoleKey) => ROLES.find((r) => r.key === k)?.label ?? k;
const catLabel = (k: string) => CATEGORIES.find((c) => c.key === k)?.label ?? k;

export function emptyCounts(): Record<Severity, number> {
  return { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 };
}

export function countBySeverity(findings: Finding[], onlyOpen = false): Record<Severity, number> {
  const c = emptyCounts();
  for (const f of findings) if (!onlyOpen || f.state === "open") c[f.severity]++;
  return c;
}

/** The latest decision per role for this release's commit. Sign-offs for another commit never count. */
export function latestDecisions(release: ReleaseRecord, signoffs: SignOff[]): Map<RoleKey, SignOff> {
  const out = new Map<RoleKey, SignOff>();
  for (const s of signoffs) {
    if (s.releaseId !== release.id || s.sha !== release.sha) continue;
    const prev = out.get(s.role);
    if (!prev || s.at >= prev.at) out.set(s.role, s);
  }
  return out;
}

export function readiness(app: AppRecord, release: ReleaseRecord, findings: Finding[], signoffs: SignOff[]): Readiness {
  const decisions = latestDecisions(release, signoffs);
  const approvedRoles = app.requiredRoles.filter((r) => decisions.get(r)?.decision === "approved");
  const rejectedRoles = app.requiredRoles.filter((r) => decisions.get(r)?.decision === "rejected");
  const missingRoles = app.requiredRoles.filter((r) => !approvedRoles.includes(r));
  const open = countBySeverity(findings.filter((f) => f.releaseId === release.id), true);
  const blocking = SEVERITIES.filter((s) => app.blockOn.includes(s) && open[s] > 0).map((s) => ({ severity: s, count: open[s] }));
  const base = { blocking, missingRoles, rejectedRoles, approvedRoles };

  if (release.supersededBy) {
    return { ...base, status: "superseded", allowed: false, reasons: ["A newer release of this application has been scanned; deploy that one instead."] };
  }
  if (release.deployedAt) {
    return { ...base, status: "deployed", allowed: true, reasons: [] };
  }
  if (!release.scannedAt) {
    return { ...base, status: "scanning", allowed: false, reasons: ["Scan results have not arrived yet."] };
  }

  const reasons: string[] = [];
  const byKey = new Map(release.categories.map((c) => [c.key, c]));
  const missingScans = app.requiredScans.filter((k) => {
    const c = byKey.get(k);
    return !c || c.status === "skipped" || c.status === "error";
  });
  for (const k of missingScans) {
    const c = byKey.get(k);
    reasons.push(`${catLabel(k)} scan ${c?.status === "error" ? "failed" : "did not run"}; it is required for this application.`);
  }
  if (missingScans.length && byKey.size && [...byKey.values()].every((c) => c.status === "skipped" || c.status === "error")) {
    return { ...base, status: "scan_failed", allowed: false, reasons };
  }
  for (const b of blocking) reasons.push(`${b.count} open ${b.severity.toLowerCase()} finding${b.count > 1 ? "s" : ""} (fix, or have the Cyber ISSM accept the risk).`);
  if (blocking.length || missingScans.length) {
    return { ...base, status: "in_remediation", allowed: false, reasons };
  }
  for (const r of rejectedRoles) reasons.push(`${roleLabel(r)} rejected this release: ${decisions.get(r)?.comment || "no comment"}.`);
  for (const r of missingRoles.filter((m) => !rejectedRoles.includes(m))) reasons.push(`Waiting for ${roleLabel(r)} sign-off.`);
  if (reasons.length) return { ...base, status: "in_review", allowed: false, reasons };
  return { ...base, status: "approved", allowed: true, reasons: [] };
}

/** Overall app risk from its current release's open findings. */
export function riskOf(open: Record<Severity, number> | null): "High" | "Medium" | "Low" | "Unknown" {
  if (!open) return "Unknown";
  if (open.Critical || open.High) return "High";
  if (open.Medium) return "Medium";
  return "Low";
}

/** Can this person sign for this role on this app? */
export function canSign(app: AppRecord, role: RoleKey, email: string | null): boolean {
  if (!email) return false;
  return (app.reviewers[role] ?? []).includes(email.toLowerCase());
}

/** Separation of duties: the person who pushed the commit cannot sign it off. */
export function isAuthor(release: ReleaseRecord, me: { id: string; email: string | null }): boolean {
  const a = release.author?.toLowerCase();
  if (!a) return false;
  const local = me.email?.toLowerCase().split("@")[0];
  return a === me.email?.toLowerCase() || a === local || a === me.id.toLowerCase();
}
