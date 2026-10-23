import type { ReactNode } from "react";
import { CATEGORIES, ROLES, SEVERITIES, type ReleaseStatus, type Severity } from "../../shared/types.ts";

export const STATUS_LABEL: Record<ReleaseStatus, string> = {
  scanning: "Scanning", in_remediation: "In remediation", in_review: "In review", approved: "Approved", deployed: "Deployed", superseded: "Superseded", scan_failed: "Scan failed",
};
export const roleLabel = (k: string) => ROLES.find((r) => r.key === k)?.label ?? k;
export const catLabel = (k: string) => CATEGORIES.find((c) => c.key === k)?.label ?? k;
export const SEV_COLOR: Record<Severity, string> = { Critical: "#b42318", High: "#e5484d", Medium: "#e3a008", Low: "#5b8def", Info: "#9aa6b8" };

export function fmtDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return withTime ? `${date}, ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })}Z` : date;
}
export const shortSha = (s: string) => s.slice(0, 8);
export const today = () => new Date().toISOString().slice(0, 10);

export function Status({ s }: { s: ReleaseStatus }) { return <span className={`status st-${s}`}>{STATUS_LABEL[s]}</span>; }
export function SevPill({ s }: { s: Severity }) { return <span className={`pill sev-${s}`}>{s}</span>; }
export function RiskPill({ r }: { r: string }) { return <span className={`pill risk-${r}`}>{r === "Unknown" ? "Not scanned" : r}</span>; }

export function Approvals({ done, total, rejected }: { done: number; total: number; rejected?: number }) {
  const c = rejected ? "var(--bad)" : done === total ? "var(--ok)" : done ? "var(--warn)" : "var(--bad)";
  return <span className="dots num" style={{ ["--c" as string]: c }}><i />{done} / {total}</span>;
}

export function Donut({ counts, size = 150 }: { counts: Record<Severity, number>; size?: number }) {
  const total = SEVERITIES.reduce((n, s) => n + counts[s], 0);
  const r = size / 2 - 10, c = 2 * Math.PI * r;
  let off = 0;
  return (
    <svg className="donut" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${total} findings`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e8edf3" strokeWidth="16" />
      {total > 0 && SEVERITIES.filter((s) => counts[s] > 0).map((s) => {
        const len = (counts[s] / total) * c;
        const el = <circle key={s} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={SEV_COLOR[s]} strokeWidth="16"
          strokeDasharray={`${Math.max(len - 2, 1)} ${c}`} strokeDashoffset={-off} transform={`rotate(-90 ${size / 2} ${size / 2})`} />;
        off += len;
        return el;
      })}
      <text x="50%" y="48%" textAnchor="middle" fontFamily="Barlow Condensed" fontWeight="600" fontSize="38" fill="#142033">{total}</text>
      <text x="50%" y="63%" textAnchor="middle" fontSize="11.5" fill="#5b6b82">total findings</text>
    </svg>
  );
}

export function SevList({ counts }: { counts: Record<Severity, number> }) {
  return (
    <ul className="sevlist">
      {SEVERITIES.map((s) => <li key={s}><span className="sw" style={{ background: SEV_COLOR[s] }} />{s}<span className="n num">{counts[s]}</span></li>)}
    </ul>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><h3>{title}</h3>{children}</div>;
}

export const Icon = {
  portfolio: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 7h16v12H4zM9 7V5h6v2M4 12h16" /></svg>,
  apps: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></svg>,
  review: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M8 4h8l3 3v13H5V4h3z" /><path d="M9 13l2 2 4-4" /></svg>,
  audit: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z" /><path d="M9 12h6M9 9h6M9 15h4" /></svg>,
  wing: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 13c4-1 6-4 9-8 3 4 5 7 9 8-4 0-6 1-9 6-3-5-5-6-9-6z" /></svg>,
  add: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 5v14M5 12h14" /></svg>,
  layers: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>,
  clock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>,
  alert: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17v.5" /></svg>,
  rocket: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M14 4c3 0 6 3 6 6l-7 7-6-6z" /><path d="M7 11l-3 1 2 2M13 17l-1 3-2-2M15 9h.01" /></svg>,
  cal: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="5" width="16" height="15" rx="1.5" /><path d="M4 10h16M9 3v4M15 3v4" /></svg>,
  shieldOk: <svg viewBox="0 0 24 24" fill="none" stroke="#1f9d6b" strokeWidth="2"><path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></svg>,
  shieldBad: <svg viewBox="0 0 24 24" fill="none" stroke="#d23c3c" strokeWidth="2"><path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z" /><path d="M12 8v5M12 16v.5" /></svg>,
  shieldWait: <svg viewBox="0 0 24 24" fill="none" stroke="#c98a07" strokeWidth="2"><path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z" /><path d="M12 8v4l2.5 1.5" /></svg>,
  dotOk: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#1f9d6b" /><path d="M7 12.5l3.5 3.5L17 9" stroke="#fff" strokeWidth="2.4" fill="none" /></svg>,
  dotBad: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#d23c3c" /><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#fff" strokeWidth="2.4" /></svg>,
  dotWait: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="#c6d1df" strokeWidth="2" strokeDasharray="3 3" /></svg>,
};
