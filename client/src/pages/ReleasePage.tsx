import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CATEGORIES, ROLES, type AppRecord, type AuditEvent, type CategoryKey, type Finding, type FindingState, type Me, type ReleaseView, type RoleKey, type SignOff } from "../../../shared/types.ts";
import { api, useApi } from "../api.ts";
import type { WingmanContext } from "../Wingman.tsx";
import { catLabel, Donut, Empty, fmtDate, Icon, roleLabel, SevList, SevPill, shortSha, Status, STATUS_LABEL } from "../ui.tsx";

interface ReleaseDetail {
  app: AppRecord; release: ReleaseView; findings: Finding[]; signoffs: SignOff[];
  mySignRoles: RoleKey[]; mySignedRole: RoleKey | null; iAmAuthor: boolean; canAcceptRisk: boolean; canMarkFalsePositive: boolean; canManage: boolean;
}

export function ReadinessBanner({ r, compact }: { r: ReleaseView; compact?: boolean }) {
  const s = r.readiness.status;
  const kind = s === "approved" || s === "deployed" ? "go" : s === "in_remediation" || s === "scan_failed" ? "blocked" : s === "in_review" ? "review" : "neutral";
  const title = s === "approved" ? "Approved for deployment. The deploy gate will pass for this commit."
    : s === "deployed" ? `Deployed to ${r.deployedTo} on ${fmtDate(r.deployedAt)}.`
    : s === "superseded" ? "Superseded by a newer release; the gate will not pass for this commit."
    : s === "scanning" ? "Waiting for scan results from the pipeline."
    : "Deployment is blocked.";
  const reasons = compact ? r.readiness.reasons.slice(0, 3) : r.readiness.reasons;
  return (
    <div className={`readiness ${kind}`} role="status">
      <span className="ic">{kind === "go" ? Icon.shieldOk : kind === "blocked" ? Icon.shieldBad : Icon.shieldWait}</span>
      <b>{title}</b>
      <span />
      {reasons.length > 0 && s !== "superseded" && <ul>{reasons.map((x) => <li key={x}>{x}</li>)}{compact && r.readiness.reasons.length > 3 && <li>…and {r.readiness.reasons.length - 3} more</li>}</ul>}
    </div>
  );
}

type Tab = "overview" | "findings" | "approvals" | "activity";

export function ReleasePage({ id, me, setWing }: { id: string; me: Me | null; setWing: (c: WingmanContext) => void }) {
  const { data, error, loading, reload } = useApi<ReleaseDetail>(`/releases/${id}`);
  const [tab, setTab] = useState<Tab>("overview");
  const [cat, setCat] = useState<CategoryKey | null>(null);

  useEffect(() => { setWing({ releaseId: id, subtitle: "Release review partner", opening: "Summarize current release" }); }, [id, setWing]);

  if (loading && !data) return <div className="loading">Loading the release…</div>;
  if (error) return <div className="err">{error}</div>;
  if (!data) return null;
  const { app, release: r } = data;
  const gl = me?.config?.gitlabUrl;
  const openCount = data.findings.filter((f) => f.state === "open").length;
  const askFix = (f: Finding) => setWing({ releaseId: id, findingId: f.id, subtitle: "Release review partner", opening: `How do I fix: ${f.title}`, nonce: Date.now() });

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><a href="#/">Portfolio</a><span aria-hidden>›</span><a href={`#/apps/${app.id}`}>{app.name}</a><span aria-hidden>›</span><span>{r.version}</span></nav>
      <div className="pagehead">
        <div><h1>{app.name} {r.version}</h1><div className="lead"><Status s={r.readiness.status} /> · commit {shortSha(r.sha)} on {r.ref}{r.author ? `, pushed by ${r.author}` : ""}</div></div>
        <div className="actions">
          {gl && <a className="btn" href={`${gl}/${app.gitlabProject}/-/commit/${r.sha}`} target="_blank" rel="noreferrer">View commit</a>}
          {r.pipelineUrl && <a className="btn" href={r.pipelineUrl} target="_blank" rel="noreferrer">Pipeline #{r.pipelineId}</a>}
        </div>
      </div>
      <ReadinessBanner r={r} />

      <div className="tabs" role="tablist">
        {([["overview", "Overview"], ["findings", "Findings"], ["approvals", "Approvals"], ["activity", "Activity"]] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)}>
            {l}{k === "findings" && <span className="count num">{openCount} open</span>}{k === "approvals" && <span className="count num">{r.readiness.approvedRoles.length}/{app.requiredRoles.length}</span>}
          </button>
        ))}
      </div>

      {tab === "overview" && <Overview d={data} reload={reload} onCat={(c) => { setCat(c); setTab("findings"); }} onFindings={() => setTab("findings")} onApprovals={() => setTab("approvals")} />}
      {tab === "findings" && <Findings d={data} reload={reload} cat={cat} setCat={setCat} askFix={askFix} />}
      {tab === "approvals" && <ApprovalsTab d={data} reload={reload} />}
      {tab === "activity" && <Activity appId={app.id} releaseId={r.id} />}
    </>
  );
}

function Overview({ d, reload, onCat, onFindings, onApprovals }: { d: ReleaseDetail; reload: () => void; onCat: (c: CategoryKey) => void; onFindings: () => void; onApprovals: () => void }) {
  const { app, release: r } = d;
  const [target, setTarget] = useState(r.targetDate ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const saveTarget = async (e: FormEvent) => {
    e.preventDefault();
    try { await api(`/releases/${r.id}`, { method: "PUT", body: { targetDate: target || null } }); setMsg("Target date saved."); reload(); }
    catch (err) { setMsg((err as Error).message); }
  };
  const top = d.findings.filter((f) => f.state === "open").slice(0, 4);
  const byKey = new Map(r.categories.map((c) => [c.key, c]));
  return (
    <>
      <div className="grid3">
        <section className="panel">
          <header><h2>Release details</h2></header>
          <dl className="kv">
            <dt>Version</dt><dd>{r.version}{r.isTag ? " (tag)" : ""}</dd>
            <dt>Commit</dt><dd className="num">{shortSha(r.sha)}</dd>
            <dt>Pushed</dt><dd>{fmtDate(r.createdAt, true)}</dd>
            <dt>Scanned</dt><dd>{fmtDate(r.scannedAt, true)}</dd>
            <dt>Target</dt><dd>{d.canManage ? (
              <form onSubmit={saveTarget} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <label className="sr" htmlFor="tgt">Target deployment date</label>
                <input id="tgt" type="date" value={target} onChange={(e) => setTarget(e.target.value)} />
                <button className="btn sm" type="submit">Save</button>
              </form>) : fmtDate(r.targetDate)}
              {msg && <div className="small muted">{msg}</div>}
            </dd>
            <dt>Deployed</dt><dd>{r.deployedAt ? `${fmtDate(r.deployedAt, true)} to ${r.deployedTo}` : "Not yet"}</dd>
          </dl>
        </section>
        <section className="panel">
          <header><h2>Scan summary</h2><button type="button" className="btn sm more" onClick={onFindings}>All findings</button></header>
          {r.scannedAt ? <div className="donutwrap"><Donut counts={r.findingCounts} /><SevList counts={r.findingCounts} /></div> : <Empty title="No scan yet" />}
        </section>
        <section className="panel">
          <header><h2>Approval status ({r.readiness.approvedRoles.length} / {app.requiredRoles.length})</h2><button type="button" className="btn sm more" onClick={onApprovals}>Sign off</button></header>
          <ApprovalList d={d} />
        </section>
      </div>

      <section className="panel">
        <header><h2>Scan results by category</h2><span className="small muted">Select a category to see its findings</span></header>
        <div className="cats">
          {CATEGORIES.map((c) => {
            const res = byKey.get(c.key);
            const n = d.findings.filter((f) => f.category === c.key && f.state === "open").length;
            const status = res?.status ?? "skipped";
            const label = status === "pass" ? "Pass" : status === "findings" ? (n ? `${n} open` : "Resolved") : status === "error" ? "Scanner error" : "Did not run";
            return (
              <button key={c.key} type="button" className="cat" onClick={() => onCat(c.key)}>
                <span className="nm">{c.label}</span><span className="tool">{c.tool}</span>
                <span className={`res ${status === "findings" && !n ? "pass" : status}`}>{label}{app.requiredScans.includes(c.key) && status !== "pass" && status !== "findings" ? " (required)" : ""}</span>
                {res?.note && <span className="note">{res.note}</span>}
              </button>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <header><h2>Key findings</h2><button type="button" className="btn sm more" onClick={onFindings}>View all {d.findings.length}</button></header>
        {top.length === 0 ? <p className="muted">No open findings.</p> : (
          <table className="table"><tbody>{top.map((f) => (
            <tr key={f.id}><td style={{ width: 96 }}><SevPill s={f.severity} /></td><td><b>{f.title}</b><div className="path">{f.path}{f.line ? `:${f.line}` : ""}</div></td><td className="small muted">{catLabel(f.category)} · {f.tool}</td></tr>
          ))}</tbody></table>
        )}
      </section>
    </>
  );
}

function ApprovalList({ d }: { d: ReleaseDetail }) {
  const latest = new Map<string, SignOff>();
  for (const s of d.signoffs) if (s.sha === d.release.sha && (!latest.get(s.role) || s.at >= latest.get(s.role)!.at)) latest.set(s.role, s);
  return (
    <ul className="approvals">
      {ROLES.filter((r) => d.app.requiredRoles.includes(r.key)).map((role) => {
        const s = latest.get(role.key);
        return (
          <li key={role.key}>
            <span className="ic">{s?.decision === "approved" ? Icon.dotOk : s?.decision === "rejected" ? Icon.dotBad : Icon.dotWait}</span>
            <span className="role">{role.label}</span>
            <span className={`dec ${s?.decision ?? "pending"}`}>{s ? (s.decision === "approved" ? "Approved" : "Rejected") : "Waiting"}</span>
            <span className="who">{s ? `${s.reviewer}, ${fmtDate(s.at, true)}` : (d.app.reviewers[role.key] ?? []).join(", ") || "No reviewer assigned"}</span>
            {s?.comment && <span className="dec small muted">“{s.comment}”</span>}
          </li>
        );
      })}
    </ul>
  );
}

const STATE_LABEL: Record<FindingState, string> = { open: "Open", accepted: "Risk accepted", false_positive: "False positive", fixed: "Fixed" };

function Findings({ d, reload, cat, setCat, askFix }: { d: ReleaseDetail; reload: () => void; cat: CategoryKey | null; setCat: (c: CategoryKey | null) => void; askFix: (f: Finding) => void }) {
  const [state, setState] = useState<"" | FindingState>("open");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = useMemo(() => d.findings.filter((f) => (!cat || f.category === cat) && (!state || f.state === state) &&
    (!q || `${f.title} ${f.path} ${f.rule} ${f.tool}`.toLowerCase().includes(q.toLowerCase()))), [d.findings, cat, state, q]);
  return (
    <section className="panel flush">
      <div className="filters" style={{ padding: 12 }}>
        <label className="sr" htmlFor="f-q">Search findings</label>
        <input id="f-q" type="search" placeholder="Search findings, files or rules" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="sr" htmlFor="f-cat">Category</label>
        <select id="f-cat" value={cat ?? ""} onChange={(e) => setCat((e.target.value || null) as CategoryKey | null)}><option value="">All categories</option>{CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
        <label className="sr" htmlFor="f-st">State</label>
        <select id="f-st" value={state} onChange={(e) => setState(e.target.value as FindingState | "")}><option value="">Any state</option>{(Object.keys(STATE_LABEL) as FindingState[]).map((s) => <option key={s} value={s}>{STATE_LABEL[s]}</option>)}</select>
        <span className="small muted num" style={{ marginLeft: "auto" }}>{rows.length} of {d.findings.length}</span>
      </div>
      {rows.length === 0 ? <Empty title={d.findings.length ? "No findings match these filters" : "This scan found nothing"} /> : (
        <div className="scroll"><table className="table">
          <thead><tr><th>Severity</th><th>Finding</th><th>Category</th><th>Tool and rule</th><th>State</th></tr></thead>
          <tbody>{rows.map((f) => (
            <FindingRow key={f.id} f={f} d={d} open={openId === f.id} toggle={() => setOpenId(openId === f.id ? null : f.id)} reload={reload} askFix={askFix} />
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}

function FindingRow({ f, d, open, toggle, reload, askFix }: { f: Finding; d: ReleaseDetail; open: boolean; toggle: () => void; reload: () => void; askFix: (f: Finding) => void }) {
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const set = async (state: FindingState) => {
    setErr(null);
    try { await api(`/findings/${f.id}/state`, { method: "POST", body: { state, note } }); setNote(""); reload(); }
    catch (e) { setErr((e as Error).message); }
  };
  const canAct = d.canAcceptRisk || d.canMarkFalsePositive;
  return (
    <>
      <tr className="click frow" onClick={toggle} aria-expanded={open}>
        <td><SevPill s={f.severity} /></td>
        <td><b>{f.title}</b><div className="path">{f.path}{f.line ? `:${f.line}` : ""}</div></td>
        <td>{catLabel(f.category)}</td>
        <td className="small">{f.tool}<div className="path">{f.rule}</div></td>
        <td><span className={`state ${f.state}`}>{STATE_LABEL[f.state]}</span></td>
      </tr>
      {open && (
        <tr className="fdetail"><td colSpan={5}><div className="box">
          <div><b>Recommendation.</b> {f.recommendation}</div>
          {f.state !== "open" && <div className="small"><b>{STATE_LABEL[f.state]}</b> by {f.stateBy} on {fmtDate(f.stateAt, true)}: {f.stateNote}</div>}
          <div className="acts">
            <button type="button" className="btn sm" style={{ color: "var(--violet)", borderColor: "#cfc4f5" }} onClick={() => askFix(f)}>{Icon.wing} Ask Wingman how to fix</button>
            {canAct && f.state === "open" && (
              <>
                <div className="field" style={{ flex: "1 1 260px" }}>
                  <label htmlFor={`n-${f.id}`}>Reason (kept in the audit trail)</label>
                  <input id={`n-${f.id}`} type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Input is a fixed enum; tracked as POA&M-12" maxLength={2000} />
                </div>
                {d.canAcceptRisk && <button type="button" className="btn sm" onClick={() => set("accepted")}>Accept risk</button>}
                {d.canMarkFalsePositive && <button type="button" className="btn sm" onClick={() => set("false_positive")}>Mark false positive</button>}
              </>
            )}
            {f.state !== "open" && d.canAcceptRisk && <button type="button" className="btn sm danger" onClick={() => set("open")}>Reopen</button>}
          </div>
          {!canAct && f.state === "open" && <div className="small muted">Only this application's Cyber ISSM can accept risk; the ISSM or Solution Architect can mark false positives.</div>}
          {err && <div className="err small">{err}</div>}
        </div></td></tr>
      )}
    </>
  );
}

function ApprovalsTab({ d, reload }: { d: ReleaseDetail; reload: () => void }) {
  const r = d.release;
  // Default to a role of mine that still needs a decision.
  const [role, setRole] = useState<RoleKey | "">(d.mySignedRole ?? d.mySignRoles.find((k) => r.readiness.missingRoles.includes(k)) ?? d.mySignRoles[0] ?? "");
  const [comment, setComment] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const blocked = ["superseded", "deployed", "scanning", "scan_failed"].includes(r.readiness.status);
  const sign = async (decision: "approved" | "rejected") => {
    setMsg(null);
    try {
      await api(`/releases/${r.id}/signoffs`, { method: "POST", body: { role, decision, comment } });
      setMsg({ ok: true, text: decision === "approved" ? `Approved as ${roleLabel(role)}.` : `Rejected as ${roleLabel(role)}.` });
      setComment(""); reload();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  return (
    <div className="grid2">
      <section className="panel">
        <header><h2>Sign-offs for commit {shortSha(r.sha)}</h2></header>
        <ApprovalList d={d} />
        <p className="small muted">Sign-offs apply to this commit only. A new push creates a new release that needs its own sign-off.</p>
      </section>
      <section className="panel">
        <header><h2>Your decision</h2></header>
        {d.mySignRoles.length === 0 ? <p className="muted">You are not a listed reviewer for this application. The owner or an admin assigns reviewers on the application's edit page.</p>
          : d.iAmAuthor ? <p className="muted">You pushed this commit, so you can't sign it off. Another reviewer for your role needs to.</p>
          : blocked ? <p className="muted">This release is {STATUS_LABEL[r.readiness.status].toLowerCase()}; it can't be signed.</p>
          : d.mySignedRole && !msg ? <p className="muted">You signed this release as {roleLabel(d.mySignedRole)}. You can change that decision below; other roles need other people.</p>
          : null}
        {d.mySignRoles.length > 0 && !d.iAmAuthor && !blocked && (
            <form className="signbox" onSubmit={(e) => e.preventDefault()}>
              <div className="field">
                <label htmlFor="role">Sign as</label>
                <select id="role" value={role} disabled={!!d.mySignedRole} onChange={(e) => setRole(e.target.value as RoleKey)}>{(d.mySignedRole ? [d.mySignedRole] : d.mySignRoles).map((k) => <option key={k} value={k}>{roleLabel(k)}</option>)}</select>
              </div>
              <div className="field">
                <label htmlFor="cm">Comment</label>
                <textarea id="cm" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} placeholder="Required when rejecting" />
              </div>
              {r.readiness.status === "in_remediation" && <div className="small" style={{ color: "var(--bad)" }}>Blocking findings are open. You can reject now; approval opens once they are fixed or risk-accepted.</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="btn ok" disabled={!role || r.readiness.status === "in_remediation"} onClick={() => sign("approved")}>Approve release</button>
                <button type="button" className="btn danger" disabled={!role || !comment.trim()} onClick={() => sign("rejected")}>Reject release</button>
              </div>
              {msg && <div className={msg.ok ? "notice" : "err"}>{msg.text}</div>}
            </form>
        )}
        {d.signoffs.length > 0 && (
          <>
            <h3 style={{ margin: "18px 0 6px" }}>History</h3>
            <div className="scroll"><table className="table"><tbody>{[...d.signoffs].reverse().map((s) => (
              <tr key={s.id}><td className="small num">{fmtDate(s.at, true)}</td><td>{roleLabel(s.role)}</td><td className={`state ${s.decision === "approved" ? "" : "open"}`} style={{ color: s.decision === "approved" ? "var(--ok)" : "var(--bad)" }}>{s.decision === "approved" ? "Approved" : "Rejected"}</td><td className="small" style={{ wordBreak: "break-all" }}>{s.reviewer}{s.sha !== r.sha && " (earlier commit)"}</td></tr>
            ))}</tbody></table></div>
          </>
        )}
      </section>
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  "scan.ingested": "Scan results ingested", "signoff.approved": "Signed off", "signoff.rejected": "Rejected", "finding.accepted": "Risk accepted",
  "finding.false_positive": "Marked false positive", "finding.open": "Finding reopened", "gate.allowed": "Deploy gate passed", "gate.denied": "Deploy gate blocked",
  "release.deployed": "Deployment recorded", "release.target_date": "Target date changed", "app.registered": "Application registered", "app.updated": "Application updated",
};
export const actionLabel = (a: string) => ACTION_LABEL[a] ?? a;

function Activity({ appId, releaseId }: { appId: string; releaseId: string }) {
  const { data, error } = useApi<AuditEvent[]>(`/audit?appId=${encodeURIComponent(appId)}`);
  if (error) return <div className="err">{error}</div>;
  const rows = (data ?? []).filter((e) => e.releaseId === releaseId);
  return (
    <section className="panel flush">
      {rows.length === 0 ? <Empty title="No activity recorded yet" /> : (
        <table className="table"><thead><tr><th>When</th><th>What</th><th>Who</th><th>Detail</th></tr></thead>
          <tbody>{rows.map((e) => (
            <tr key={e.id}><td className="small num">{fmtDate(e.at, true)}</td><td>{actionLabel(e.action)}</td><td className="small">{e.actor}</td>
              <td className="small muted">{describe(e)}</td></tr>
          ))}</tbody></table>
      )}
    </section>
  );
}

export function describe(e: AuditEvent): string {
  const d = e.detail as Record<string, any>;
  if (e.action.startsWith("signoff.")) return `${roleLabel(d.role)}${d.comment ? `: “${d.comment}”` : ""}`;
  if (e.action.startsWith("finding.")) return `${d.severity ?? ""} ${d.title ?? ""}${d.note ? `: ${d.note}` : ""}`.trim();
  if (e.action === "scan.ingested") return `Pipeline ${d.pipelineId}, ${d.findings} findings from ${d.scanJobs} scan jobs`;
  if (e.action.startsWith("gate.")) return (d.reasons as string[] | undefined)?.join(" ") || "All checks passed";
  if (e.action === "release.deployed") return `To ${d.environment}`;
  if (e.action === "release.target_date") return d.targetDate ? `Set to ${d.targetDate}` : "Cleared";
  if (e.action === "app.updated") return `Changed ${(d.fields as string[]).join(", ")}`;
  if (e.action === "app.registered") return d.gitlabProject;
  return "";
}
