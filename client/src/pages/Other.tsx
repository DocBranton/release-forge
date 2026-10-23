import { useState, type FormEvent } from "react";
import { CATEGORIES, ROLES, SEVERITIES, type AppRecord, type AppSummary, type AuditEvent, type Me, type RoleKey } from "../../../shared/types.ts";
import { api, useApi } from "../api.ts";
import { Empty, fmtDate, roleLabel, Status } from "../ui.tsx";
import { actionLabel, describe } from "./ReleasePage.tsx";

/** Releases waiting on the signed-in person, as reviewer or as Cyber ISSM. */
export function myQueue(apps: AppSummary[], email: string | null) {
  const e = email?.toLowerCase() ?? "";
  const sign: { app: AppSummary; roles: RoleKey[] }[] = [];
  const risk: AppSummary[] = [];
  for (const a of apps) {
    const r = a.current;
    if (!r || !e) continue;
    const mine = r.readiness.missingRoles.filter((role) => (a.reviewers[role] ?? []).includes(e));
    if (r.readiness.status === "in_review" && mine.length) sign.push({ app: a, roles: mine });
    if (r.readiness.status === "in_remediation" && (a.reviewers.issm ?? []).includes(e)) risk.push(a);
  }
  return { sign, risk };
}

export function ReviewsPage({ me }: { me: Me | null }) {
  const { data, error, loading } = useApi<{ apps: AppSummary[] }>("/portfolio");
  if (loading && !data) return <div className="loading">Loading your reviews…</div>;
  if (error) return <div className="err">{error}</div>;
  const { sign, risk } = myQueue(data?.apps ?? [], me?.email ?? null);
  return (
    <>
      <div className="pagehead"><div><h1>My reviews</h1><div className="lead">Releases waiting for your sign-off, and blocked releases where you are the Cyber ISSM.</div></div></div>
      <section className="panel flush">
        <header style={{ padding: "16px 18px 0" }}><h2>Waiting for your sign-off</h2></header>
        {sign.length === 0 ? <Empty title="Nothing is waiting on you" /> : (
          <table className="table" style={{ marginTop: 10 }}><thead><tr><th>Application</th><th>Release</th><th>Your role</th><th>Scanned</th><th>Target</th></tr></thead>
            <tbody>{sign.map(({ app, roles }) => (
              <tr key={app.id} className="click" onClick={() => { location.hash = `#/releases/${app.current!.id}`; }}>
                <td><b>{app.name}</b></td><td><a href={`#/releases/${app.current!.id}`}>{app.current!.version}</a></td>
                <td>{roles.map(roleLabel).join(", ")}</td><td className="num small">{fmtDate(app.current!.scannedAt, true)}</td><td className="num">{fmtDate(app.current!.targetDate)}</td>
              </tr>
            ))}</tbody></table>
        )}
      </section>
      <section className="panel flush">
        <header style={{ padding: "16px 18px 0" }}><h2>Blocked releases you can risk-accept</h2></header>
        {risk.length === 0 ? <Empty title="No blocked releases for your applications" /> : (
          <table className="table" style={{ marginTop: 10 }}><thead><tr><th>Application</th><th>Release</th><th>Status</th><th>Open critical / high</th></tr></thead>
            <tbody>{risk.map((a) => (
              <tr key={a.id} className="click" onClick={() => { location.hash = `#/releases/${a.current!.id}`; }}>
                <td><b>{a.name}</b></td><td><a href={`#/releases/${a.current!.id}`}>{a.current!.version}</a></td><td><Status s={a.current!.readiness.status} /></td>
                <td className="num">{a.current!.openCounts.Critical} / {a.current!.openCounts.High}</td>
              </tr>
            ))}</tbody></table>
        )}
      </section>
    </>
  );
}

export function AuditPage() {
  const { data, error, loading } = useApi<AuditEvent[]>("/audit");
  const apps = useApi<{ apps: AppSummary[] }>("/portfolio");
  const [q, setQ] = useState("");
  if (loading && !data) return <div className="loading">Loading the audit trail…</div>;
  if (error) return <div className="err">{error}</div>;
  const name = (id: string | null) => apps.data?.apps.find((a) => a.id === id)?.name ?? "—";
  const rows = (data ?? []).filter((e) => !q || `${e.actor} ${e.action} ${name(e.appId)} ${describe(e)}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="pagehead"><div><h1>Audit trail</h1><div className="lead">Every scan, sign-off, risk decision and gate result, newest first.</div></div></div>
      <section className="panel flush">
        <div className="filters" style={{ padding: 12 }}>
          <label className="sr" htmlFor="au-q">Filter</label>
          <input id="au-q" type="search" placeholder="Filter by person, application or action" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {rows.length === 0 ? <Empty title="No events" /> : (
          <div className="scroll"><table className="table"><thead><tr><th>When</th><th>Application</th><th>What</th><th>Who</th><th>Detail</th></tr></thead>
            <tbody>{rows.map((e) => (
              <tr key={e.id}><td className="num small">{fmtDate(e.at, true)}</td><td>{e.appId ? <a href={`#/apps/${e.appId}`}>{name(e.appId)}</a> : "—"}</td>
                <td>{e.releaseId ? <a href={`#/releases/${e.releaseId}`}>{actionLabel(e.action)}</a> : actionLabel(e.action)}</td><td className="small">{e.actor}</td><td className="small muted">{describe(e)}</td></tr>
            ))}</tbody></table></div>
        )}
      </section>
    </>
  );
}

const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function AppForm({ me, id }: { me: Me | null; id?: string }) {
  const existing = useApi<{ app: AppRecord; canManage: boolean }>(id ? `/apps/${id}` : null);
  const a = existing.data?.app;
  if (id && !a) return existing.error ? <div className="err">{existing.error}</div> : <div className="loading">Loading…</div>;
  if (!id && !me?.admin) return <div className="err">Only Release Forge admins can register applications. Admins are listed in the app's APP_ADMINS setting.</div>;
  return <AppFormInner me={me} app={a} />;
}

function AppFormInner({ me, app }: { me: Me | null; app?: AppRecord }) {
  const admin = !!me?.admin;
  const [f, setF] = useState({
    name: app?.name ?? "", program: app?.program ?? "", description: app?.description ?? "", gitlabProject: app?.gitlabProject ?? "",
    defaultBranch: app?.defaultBranch ?? "main", environments: (app?.environments ?? ["DEV", "TEST", "PROD"]).join(", "), owner: app?.owner ?? "",
    requiredRoles: app?.requiredRoles ?? (ROLES.map((r) => r.key) as RoleKey[]),
    reviewers: Object.fromEntries(ROLES.map((r) => [r.key, (app?.reviewers[r.key] ?? []).join(", ")])) as Record<RoleKey, string>,
    blockOn: app?.blockOn ?? ["Critical", "High"], requiredScans: app?.requiredScans ?? ["sast", "secrets", "sbom"],
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    const body: Record<string, unknown> = {
      name: f.name, program: f.program, description: f.description, defaultBranch: f.defaultBranch, environments: csv(f.environments),
      reviewers: Object.fromEntries(Object.entries(f.reviewers).map(([k, v]) => [k, csv(v)])),
    };
    if (admin) Object.assign(body, { gitlabProject: f.gitlabProject, owner: f.owner, requiredRoles: f.requiredRoles, blockOn: f.blockOn, requiredScans: f.requiredScans });
    try {
      const saved = await api<AppRecord>(app ? `/apps/${app.id}` : "/apps", { method: app ? "PUT" : "POST", body });
      location.hash = `#/apps/${saved.id}`;
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="pagehead"><div><h1>{app ? `Edit ${app.name}` : "Register application"}</h1>
        <div className="lead">{app ? "Owners can change details and reviewers; admins also change the project and approval policy." : "Point Release Forge at a GitLab project. Add the Release Forge CI template to that project so its pipelines report scans."}</div></div></div>
      <form className="panel" onSubmit={submit} style={{ display: "grid", gap: 16, maxWidth: 860 }}>
        <div className="grid2">
          <div className="field"><label htmlFor="nm">Name</label><input id="nm" type="text" required maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="pg">Program</label><input id="pg" type="text" maxLength={120} value={f.program} onChange={(e) => setF({ ...f, program: e.target.value })} placeholder="e.g. RSO / AMPO" /></div>
        </div>
        <div className="field"><label htmlFor="ds">Description</label><textarea id="ds" maxLength={1000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
        <div className="grid2">
          <div className="field"><label htmlFor="gp">GitLab project path</label><input id="gp" type="text" required disabled={!admin} value={f.gitlabProject} onChange={(e) => setF({ ...f, gitlabProject: e.target.value })} placeholder="group/subgroup/project" /><span className="hint">{me?.config?.gitlabUrl ? `On ${me.config.gitlabUrl}` : "On the GitLab host set in GITLAB_URL"}</span></div>
          <div className="field"><label htmlFor="br">Release branch</label><input id="br" type="text" value={f.defaultBranch} onChange={(e) => setF({ ...f, defaultBranch: e.target.value })} /><span className="hint">Pushes to this branch and all tags become releases.</span></div>
        </div>
        <div className="grid2">
          <div className="field"><label htmlFor="ow">Application owner (email)</label><input id="ow" type="email" disabled={!admin} value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} /><span className="hint">Can edit reviewers, set target dates and poll GitLab.</span></div>
          <div className="field"><label htmlFor="en">Environments</label><input id="en" type="text" value={f.environments} onChange={(e) => setF({ ...f, environments: e.target.value })} /><span className="hint">Comma-separated.</span></div>
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 500, fontSize: 13, marginBottom: 6 }}>Sign-offs and reviewers</legend>
          {ROLES.map((r) => (
            <div key={r.key} style={{ display: "grid", gridTemplateColumns: "minmax(200px, 240px) 1fr", gap: 10, alignItems: "center", marginBottom: 6 }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" disabled={!admin} checked={f.requiredRoles.includes(r.key)} onChange={() => setF({ ...f, requiredRoles: toggle(f.requiredRoles, r.key) })} />{r.label}</label>
              <input type="text" aria-label={`${r.label} reviewers`} value={f.reviewers[r.key]} onChange={(e) => setF({ ...f, reviewers: { ...f.reviewers, [r.key]: e.target.value } })} placeholder="reviewer@example.mil, backup@example.mil" />
            </div>
          ))}
        </fieldset>
        <div className="grid2">
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }} disabled={!admin}>
            <legend style={{ fontWeight: 500, fontSize: 13, marginBottom: 6 }}>Open findings that block deployment</legend>
            <div className="chips">{SEVERITIES.map((s) => <label key={s} style={{ display: "flex", gap: 6, alignItems: "center", marginRight: 10 }}><input type="checkbox" checked={f.blockOn.includes(s)} onChange={() => setF({ ...f, blockOn: toggle(f.blockOn, s) })} />{s}</label>)}</div>
          </fieldset>
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }} disabled={!admin}>
            <legend style={{ fontWeight: 500, fontSize: 13, marginBottom: 6 }}>Scans that must run</legend>
            <div className="chips">{CATEGORIES.map((c) => <label key={c.key} style={{ display: "flex", gap: 6, alignItems: "center", marginRight: 10 }}><input type="checkbox" checked={f.requiredScans.includes(c.key)} onChange={() => setF({ ...f, requiredScans: toggle(f.requiredScans, c.key) })} />{c.label}</label>)}</div>
          </fieldset>
        </div>
        {err && <div className="err">{err}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn primary" type="submit" disabled={busy}>{busy ? "Saving…" : app ? "Save changes" : "Register application"}</button>
          <a className="btn" href={app ? `#/apps/${app.id}` : "#/apps"}>Cancel</a>
        </div>
      </form>
    </>
  );
}
