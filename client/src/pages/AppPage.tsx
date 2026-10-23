import { useState } from "react";
import { ROLES, type AppRecord, type Me, type PollState, type ReleaseView } from "../../../shared/types.ts";
import { api, useApi } from "../api.ts";
import { Approvals, catLabel, Donut, Empty, fmtDate, Icon, RiskPill, SevList, shortSha, Status } from "../ui.tsx";
import { ReadinessBanner } from "./ReleasePage.tsx";

interface AppDetail { app: AppRecord; releases: ReleaseView[]; poll: PollState | null; currentId: string | null; canManage: boolean }

export function AppPage({ id, me }: { id: string; me: Me | null }) {
  const { data, error, loading, reload } = useApi<AppDetail>(`/apps/${id}`);
  const [polling, setPolling] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (loading && !data) return <div className="loading">Loading the application…</div>;
  if (error) return <div className="err">{error}</div>;
  if (!data) return null;
  const { app, releases, poll } = data;
  const cur = releases.find((r) => r.id === data.currentId) ?? null;
  const gl = me?.config?.gitlabUrl;
  const risk = cur?.scannedAt ? (cur.openCounts.Critical || cur.openCounts.High ? "High" : cur.openCounts.Medium ? "Medium" : "Low") : "Unknown";

  const pollNow = async () => {
    setPolling(true); setNote(null);
    try {
      const r = await api<{ ingested: number; error?: string }>(`/apps/${app.id}/poll`, { method: "POST" });
      setNote(r.error ? `GitLab returned an error: ${r.error}` : r.ingested ? `Picked up ${r.ingested} new pipeline${r.ingested > 1 ? "s" : ""}.` : "No new release pipelines since the last poll.");
      await reload();
    } catch (e) { setNote((e as Error).message); } finally { setPolling(false); }
  };

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><a href="#/">Portfolio</a><span aria-hidden>›</span><a href="#/apps">Applications</a><span aria-hidden>›</span><span>{app.name}</span></nav>
      <div className="pagehead">
        <div><h1>{app.name}</h1><div className="lead">{app.description || "No description."}</div></div>
        <div className="actions">
          {gl && <a className="btn" href={`${gl}/${app.gitlabProject}`} target="_blank" rel="noreferrer">Open in GitLab</a>}
          {data.canManage && <button type="button" className="btn" onClick={pollNow} disabled={polling}>{polling ? "Polling…" : "Poll GitLab now"}</button>}
          {data.canManage && <a className="btn" href={`#/apps/${app.id}/edit`}>Edit application</a>}
          {cur && <a className="btn primary" href={`#/releases/${cur.id}`}>Open review workspace</a>}
        </div>
      </div>
      {note && <div className={note.startsWith("GitLab returned") ? "err" : "notice"}>{note}</div>}

      <section className="tiles" aria-label="Current release">
        <div><span className="lab">{app.program || "No program"} · {app.gitlabProject}</span><span>{cur ? <Status s={cur.readiness.status} /> : <span className="muted">Waiting for the first release pipeline</span>}</span></div>
        <div><span className="big">{cur?.version ?? "—"}</span><span className="lab">Current release</span></div>
        <div><span className="big num">{fmtDate(cur?.targetDate)}</span><span className="lab">Target deployment</span></div>
        <div><span><RiskPill r={risk} /></span><span className="lab">Risk (open findings)</span></div>
        <div><span className="big">{cur ? <Approvals done={cur.readiness.approvedRoles.length} total={app.requiredRoles.length} rejected={cur.readiness.rejectedRoles.length} /> : "—"}</span><span className="lab">Sign-offs</span></div>
      </section>

      {cur && <ReadinessBanner r={cur} compact />}

      <div className="grid2">
        <section className="panel">
          <header><h2>Application summary</h2>{data.canManage && <a className="more" href={`#/apps/${app.id}/edit`}>Edit</a>}</header>
          <dl className="kv">
            <dt>Repository</dt><dd>{gl ? <a href={`${gl}/${app.gitlabProject}`} target="_blank" rel="noreferrer">{app.gitlabProject}</a> : app.gitlabProject}</dd>
            <dt>Release branch</dt><dd>{app.defaultBranch} and tags</dd>
            <dt>Owner</dt><dd>{app.owner || <span className="muted">Not set</span>}</dd>
            <dt>Environments</dt><dd><div className="chips">{app.environments.length ? app.environments.map((e) => <span className="chip" key={e}>{e}</span>) : <span className="muted">None listed</span>}</div></dd>
            <dt>Blocks on</dt><dd>{app.blockOn.join(", ") || "Nothing"} findings</dd>
            <dt>Required scans</dt><dd>{app.requiredScans.map(catLabel).join(", ") || "None"}</dd>
            <dt>Last poll</dt><dd>{poll?.lastPolledAt ? fmtDate(poll.lastPolledAt, true) : "Not yet"}{poll?.lastError && <div className="err small" style={{ marginTop: 4 }}>{poll.lastError}</div>}</dd>
          </dl>
        </section>
        <section className="panel">
          <header><h2>Required sign-offs</h2></header>
          <ul className="approvals">
            {ROLES.filter((r) => app.requiredRoles.includes(r.key)).map((r) => {
              const dec = cur?.readiness.approvedRoles.includes(r.key) ? "approved" : cur?.readiness.rejectedRoles.includes(r.key) ? "rejected" : "pending";
              return (
                <li key={r.key}>
                  <span className="ic">{dec === "approved" ? Icon.dotOk : dec === "rejected" ? Icon.dotBad : Icon.dotWait}</span>
                  <span className="role">{r.label}</span>
                  <span className={`dec ${dec}`}>{dec === "pending" ? "Waiting" : dec === "approved" ? "Approved" : "Rejected"}</span>
                  <span className="who">{(app.reviewers[r.key] ?? []).join(", ") || <span style={{ color: "var(--bad)" }}>No reviewer assigned</span>}</span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      {cur?.scannedAt && (
        <section className="panel">
          <header><h2>Current release scan</h2><a className="more" href={`#/releases/${cur.id}`}>View all findings</a></header>
          <div className="donutwrap"><Donut counts={cur.findingCounts} /><SevList counts={cur.findingCounts} />
            <div className="small muted" style={{ maxWidth: 320 }}>Scanned {fmtDate(cur.scannedAt, true)} from commit {shortSha(cur.sha)}. {cur.openCounts.Critical + cur.openCounts.High} critical or high findings are still open.</div>
          </div>
        </section>
      )}

      <section className="panel flush">
        <header style={{ padding: "16px 18px 0" }}><h2>Releases</h2></header>
        {releases.length === 0 ? (
          <Empty title="No releases yet"><span>Release Forge picks up pushes to {app.defaultBranch} and tags once the pipeline includes the Release Forge CI template.</span></Empty>
        ) : (
          <div className="scroll"><table className="table" style={{ marginTop: 10 }}>
            <thead><tr><th>Release</th><th>Status</th><th>Commit</th><th>Pushed by</th><th>Scanned</th><th>Open findings</th><th>Target</th><th>Deployed</th></tr></thead>
            <tbody>{releases.map((r) => (
              <tr key={r.id} className="click" onClick={() => { location.hash = `#/releases/${r.id}`; }}>
                <td><a href={`#/releases/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.version}</a>{r.isTag && <span className="chip" style={{ marginLeft: 6 }}>tag</span>}</td>
                <td><Status s={r.readiness.status} /></td>
                <td className="num small">{gl ? <a href={`${gl}/${app.gitlabProject}/-/commit/${r.sha}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{shortSha(r.sha)}</a> : shortSha(r.sha)}</td>
                <td>{r.author ?? "—"}</td>
                <td className="num small">{fmtDate(r.scannedAt, true)}</td>
                <td className="num">{r.scannedAt ? `${r.openCounts.Critical + r.openCounts.High} critical/high, ${r.openCounts.Medium} medium` : "—"}</td>
                <td className="num">{fmtDate(r.targetDate)}</td>
                <td>{r.deployedAt ? `${fmtDate(r.deployedAt)} (${r.deployedTo})` : "—"}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
