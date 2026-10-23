import { useMemo, useState } from "react";
import type { AppSummary, Me, ReleaseStatus } from "../../../shared/types.ts";
import { useApi } from "../api.ts";
import { Approvals, Empty, fmtDate, Icon, RiskPill, Status, STATUS_LABEL, today } from "../ui.tsx";

interface Kpis { fiscalYear: number; applications: number; releasesThisFY: number; inReview: number; awaitingOver7Days: number; inRemediation: number; criticalOpen: number; approved: number; scheduledThisMonth: number; deployedThisMonth: number }
interface Portfolio { apps: AppSummary[]; kpis: Kpis; gitlabConfigured: boolean }

const MONTHS = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"];
const fyStart = (fy: number) => Date.UTC(fy - 1, 9, 1);
const fyEnd = (fy: number) => Date.UTC(fy, 9, 1);
const pct = (fy: number, t: number) => Math.min(100, Math.max(0, ((t - fyStart(fy)) / (fyEnd(fy) - fyStart(fy))) * 100));

function Timeline({ fy, a }: { fy: number; a: AppSummary }) {
  const r = a.current;
  const now = pct(fy, Date.now());
  if (!r) return <div className="tl"><span className="today" style={{ left: `${now}%` }} /></div>;
  const start = new Date(r.createdAt).getTime();
  const goal = r.targetDate ? Date.parse(`${r.targetDate}T00:00:00Z`) : null;
  const end = r.deployedAt ? new Date(r.deployedAt).getTime() : goal ?? start + 14 * 86_400_000;
  const left = pct(fy, start), width = Math.max(pct(fy, Math.max(end, start)) - left, 1.2);
  const s = r.readiness.status;
  return (
    <div className="tl">
      <span className={`bar st-${s}`} style={{ left: `${left}%`, width: `${width}%` }} title={`${r.version}: ${STATUS_LABEL[s]}`}>{width > 6 ? r.version : ""}</span>
      {goal && <span className="goal" style={{ left: `${pct(fy, goal)}%`, ["--c" as string]: goal < Date.now() && !r.deployedAt ? "var(--bad)" : "var(--blue)" }} title={`Target ${fmtDate(r.targetDate)}`} />}
      <span className="today" style={{ left: `${now}%` }} />
    </div>
  );
}

export function PortfolioPage({ me, listOnly }: { me: Me | null; listOnly?: boolean }) {
  const { data, error, loading } = useApi<Portfolio>("/portfolio");
  const [view, setView] = useState<"timeline" | "list">(listOnly ? "list" : "timeline");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | ReleaseStatus>("");
  const [risk, setRisk] = useState("");
  const [program, setProgram] = useState("");

  const programs = useMemo(() => [...new Set((data?.apps ?? []).map((a) => a.program).filter(Boolean))].sort(), [data]);
  const rows = useMemo(() => (data?.apps ?? []).filter((a) =>
    (!q || `${a.name} ${a.gitlabProject} ${a.program}`.toLowerCase().includes(q.toLowerCase())) &&
    (!status || a.current?.readiness.status === status) && (!risk || a.risk === risk) && (!program || a.program === program)), [data, q, status, risk, program]);

  if (loading && !data) return <div className="loading">Loading the portfolio…</div>;
  if (error) return <div className="err">{error}</div>;
  if (!data) return null;
  const k = data.kpis, fy = k.fiscalYear, fyLabel = `FY${String(fy).slice(2)}`;
  const nowPct = pct(fy, Date.now());

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>{listOnly ? "Applications" : "Portfolio"}</h1>
          <div className="lead">{listOnly ? "Every application Release Forge oversees, with its current release." : `Release readiness across your GitLab applications, ${fyLabel}.`}</div>
        </div>
        <div className="actions">{me?.admin && <a className="btn primary" href="#/apps/new">{Icon.add}Register application</a>}</div>
      </div>

      {!data.gitlabConfigured && !me?.config?.demo && <div className="demo-band">GitLab polling is off: set GITLAB_URL and the gitlab-token secret resource so new pipelines arrive automatically.</div>}

      {!listOnly && (
        <section className="kpis" aria-label="Portfolio figures">
          <div className="kpi"><span className="ic" style={{ background: "var(--blue-soft)", color: "var(--blue)" }}>{Icon.layers}</span><span className="v num">{k.applications}</span><span className="l">Applications</span><span className="d">{k.releasesThisFY} releases scanned in {fyLabel}</span></div>
          <div className="kpi"><span className="ic" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>{Icon.clock}</span><span className="v num">{k.inReview}</span><span className="l">In review</span><span className={`d ${k.awaitingOver7Days ? "warn" : ""}`}>{k.awaitingOver7Days} waiting over 7 days</span></div>
          <div className="kpi"><span className="ic" style={{ background: "var(--bad-soft)", color: "var(--bad)" }}>{Icon.alert}</span><span className="v num">{k.inRemediation}</span><span className="l">In remediation</span><span className={`d ${k.criticalOpen ? "bad" : ""}`}>{k.criticalOpen} critical open</span></div>
          <div className="kpi"><span className="ic" style={{ background: "var(--ok-soft)", color: "var(--ok)" }}>{Icon.check}</span><span className="v num">{k.approved}</span><span className="l">Approved</span><span className="d">{k.scheduledThisMonth} scheduled this month</span></div>
          <div className="kpi"><span className="ic" style={{ background: "#e7ecf5", color: "var(--deployed)" }}>{Icon.rocket}</span><span className="v num">{k.deployedThisMonth}</span><span className="l">Deployed</span><span className="d">this month</span></div>
        </section>
      )}

      <section className="panel flush">
        <div className="filters" style={{ padding: 12 }}>
          {!listOnly && (
            <div className="seg" role="group" aria-label="View">
              <button type="button" aria-pressed={view === "timeline"} onClick={() => setView("timeline")}>Timeline</button>
              <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>List</button>
            </div>
          )}
          <label className="sr" htmlFor="pf-q">Search applications</label>
          <input id="pf-q" type="search" placeholder="Search applications" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="sr" htmlFor="pf-prog">Program</label>
          <select id="pf-prog" value={program} onChange={(e) => setProgram(e.target.value)}><option value="">All programs</option>{programs.map((p) => <option key={p}>{p}</option>)}</select>
          <label className="sr" htmlFor="pf-st">Status</label>
          <select id="pf-st" value={status} onChange={(e) => setStatus(e.target.value as ReleaseStatus | "")}>
            <option value="">All statuses</option>{(["in_remediation", "in_review", "approved", "deployed", "scanning", "scan_failed"] as ReleaseStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
          <label className="sr" htmlFor="pf-risk">Risk</label>
          <select id="pf-risk" value={risk} onChange={(e) => setRisk(e.target.value)}><option value="">All risk levels</option><option>High</option><option>Medium</option><option>Low</option><option value="Unknown">Not scanned</option></select>
        </div>
        {data.apps.length === 0 ? (
          <Empty title="No applications yet">
            <span>{me?.admin ? "Register a GitLab project to start tracking its releases." : "Ask a Release Forge admin to register your GitLab project."}</span>
            {me?.admin && <a className="btn primary" href="#/apps/new">Register application</a>}
          </Empty>
        ) : rows.length === 0 ? <Empty title="No applications match these filters" /> : (
          <div className="scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Application</th><th>Program</th><th>Current release</th><th>Risk</th><th>Approvals</th>
                  {view === "list" ? <><th>Status</th><th>Target date</th><th>Open findings</th></> : <><th>Next milestone</th>
                    <th style={{ padding: 0, position: "relative" }}>
                      <div className="tlhead num" style={{ gridTemplateColumns: "repeat(12, 1fr)", paddingTop: 26 }}>
                        <span className="todaylabel" style={{ left: `${nowPct}%`, top: 4 }}>Today {fmtDate(today()).replace(/, \d{4}$/, "")}</span>
                        {MONTHS.map((m) => <span key={m}>{m}</span>)}
                      </div>
                    </th></>}
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const r = a.current;
                  const go = () => { location.hash = `#/apps/${a.id}`; };
                  return (
                    <tr key={a.id} className="click" onClick={go}>
                      <td className="appcell"><a href={`#/apps/${a.id}`} onClick={(e) => e.stopPropagation()}><b>{a.name}</b></a><div className="path" title={a.gitlabProject}>{a.gitlabProject}</div></td>
                      <td>{a.program || "—"}</td>
                      <td>{r ? <a href={`#/releases/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.version}</a> : <span className="muted">No release yet</span>}</td>
                      <td><RiskPill r={a.risk} /></td>
                      <td>{r ? <Approvals done={r.readiness.approvedRoles.length} total={a.requiredRoles.length} rejected={r.readiness.rejectedRoles.length} /> : "—"}</td>
                      {view === "list" ? (
                        <>
                          <td>{r ? <Status s={r.readiness.status} /> : "—"}</td>
                          <td className="num">{fmtDate(r?.targetDate)}</td>
                          <td className="num">{r ? `${r.openCounts.Critical + r.openCounts.High} critical/high, ${r.openCounts.Medium} medium` : "—"}</td>
                        </>
                      ) : (
                        <>
                          <td className="small">{r ? <>{r.targetDate ? <span className="num">{fmtDate(r.targetDate)}</span> : <span className="muted">No target</span>}<div className="muted">{r.readiness.status === "deployed" ? `Deployed to ${r.deployedTo}` : r.readiness.status === "approved" ? `Deploy ${r.version}` : STATUS_LABEL[r.readiness.status]}</div></> : "—"}</td>
                          <td className="tlcell"><Timeline fy={fy} a={a} /></td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {view === "timeline" && rows.length > 0 && (
          <div className="legend">
            {(["scanning", "in_review", "in_remediation", "approved", "deployed"] as ReleaseStatus[]).map((s) => <span key={s} className={`status st-${s}`}>{STATUS_LABEL[s]}</span>)}
            <span>◇ Target date</span><span style={{ color: "var(--bad)" }}>┆ Today</span>
          </div>
        )}
      </section>
    </>
  );
}
