// Shared between the server and the browser. No runtime imports.

export const SEVERITIES = ["Critical", "High", "Medium", "Low", "Info"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Scan categories, in the order the UI shows them. */
export const CATEGORIES = [
  { key: "bundle", label: "Bundle Structure", tool: "databricks bundle validate" },
  { key: "sast", label: "SAST", tool: "Semgrep" },
  { key: "sbom", label: "SBOM", tool: "npm audit" },
  { key: "secrets", label: "Secrets", tool: "Gitleaks" },
  { key: "owasp", label: "OWASP Top 10", tool: "Semgrep (OWASP rules)" },
  { key: "iac", label: "IaC", tool: "Checkov" },
  { key: "malware", label: "AV / Malware", tool: "ClamAV" },
] as const;
export type CategoryKey = (typeof CATEGORIES)[number]["key"];

export type CategoryStatus = "pass" | "findings" | "skipped" | "error";
export interface CategoryResult { key: CategoryKey; status: CategoryStatus; note: string; counts: Partial<Record<Severity, number>> }

export type FindingState = "open" | "accepted" | "false_positive" | "fixed";
export interface Finding {
  id: string;
  releaseId: string;
  /** Stable across scans of the same app: tool + rule + location. */
  fingerprint: string;
  category: CategoryKey;
  severity: Severity;
  tool: string;
  rule: string;
  title: string;
  path: string;
  line: number | null;
  recommendation: string;
  state: FindingState;
  stateBy: string | null;
  stateNote: string | null;
  stateAt: string | null;
}

/** Roles that can sign off a release. Apps choose which are required. */
export const ROLES = [
  { key: "pm", label: "Program Manager" },
  { key: "architect", label: "Solution Architect" },
  { key: "functional", label: "Functional Representative" },
  { key: "config", label: "Configuration Manager" },
  { key: "test", label: "Test Manager" },
  { key: "issm", label: "Cyber ISSM" },
] as const;
export type RoleKey = (typeof ROLES)[number]["key"];

export interface AppRecord {
  id: string;
  name: string;
  program: string;
  description: string;
  /** GitLab project path, e.g. "group/sub/project". The GitLab host is set by the server, not per app. */
  gitlabProject: string;
  defaultBranch: string;
  environments: string[];
  requiredRoles: RoleKey[];
  /** Emails allowed to sign for each role (lower case). */
  reviewers: Partial<Record<RoleKey, string[]>>;
  /** Severities that block deployment unless risk-accepted. */
  blockOn: Severity[];
  /** Scan categories that must have run (not skipped or errored) before a release can be approved. */
  requiredScans: CategoryKey[];
  owner: string;
  createdAt: string;
  createdBy: string;
}

export type ReleaseStatus = "scanning" | "in_remediation" | "in_review" | "approved" | "deployed" | "superseded" | "scan_failed";

export interface ReleaseRecord {
  id: string;
  appId: string;
  version: string;
  sha: string;
  ref: string;
  isTag: boolean;
  pipelineId: number | null;
  pipelineUrl: string | null;
  author: string | null;
  createdAt: string;
  scannedAt: string | null;
  targetDate: string | null;
  deployedAt: string | null;
  deployedTo: string | null;
  categories: CategoryResult[];
  /** Set when a newer release of the same app arrives. */
  supersededBy: string | null;
}

export type Decision = "approved" | "rejected";
export interface SignOff {
  id: string;
  releaseId: string;
  sha: string;
  role: RoleKey;
  reviewer: string;
  decision: Decision;
  comment: string;
  at: string;
}

export interface AuditEvent { id: number; at: string; actor: string; action: string; appId: string | null; releaseId: string | null; detail: Record<string, unknown> }

export interface PollState { appId: string; lastPipelineId: number; lastPolledAt: string | null; lastError: string | null }

/** What the gate and the UI agree a release's readiness is. */
export interface Readiness {
  status: ReleaseStatus;
  blocking: { severity: Severity; count: number }[];
  missingRoles: RoleKey[];
  rejectedRoles: RoleKey[];
  approvedRoles: RoleKey[];
  allowed: boolean;
  reasons: string[];
}

export interface Me { id: string; email: string | null; admin: boolean; config?: { classification: string; gitlabUrl: string | null; demo: boolean } }

export interface ReleaseView extends ReleaseRecord { readiness: Readiness; findingCounts: Record<Severity, number>; openCounts: Record<Severity, number> }
export interface AppSummary extends AppRecord { current: ReleaseView | null; releases: number; poll: PollState | null; risk: "High" | "Medium" | "Low" | "Unknown" }
