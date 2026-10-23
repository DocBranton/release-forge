// Assembles what the UI, Wingman and gate read: apps with their current release and readiness.
import type { AppRecord, AppSummary, Finding, ReleaseRecord, ReleaseView, SignOff } from "../shared/types.ts";
import { countBySeverity, readiness, riskOf } from "./policy.ts";
import type { Store } from "./store.ts";

export function releaseView(app: AppRecord, r: ReleaseRecord, findings: Finding[], signoffs: SignOff[]): ReleaseView {
  const mine = findings.filter((f) => f.releaseId === r.id);
  return { ...r, readiness: readiness(app, r, mine, signoffs), findingCounts: countBySeverity(mine), openCounts: countBySeverity(mine, true) };
}

/** The release a portfolio row shows: newest not superseded, else newest. */
export function currentOf(releases: ReleaseRecord[]): ReleaseRecord | null {
  const sorted = [...releases].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return sorted.find((r) => !r.supersededBy) ?? sorted[0] ?? null;
}

export async function portfolio(store: Store): Promise<AppSummary[]> {
  const [apps, releases] = await Promise.all([store.listApps(), store.listReleases()]);
  const byApp = new Map<string, ReleaseRecord[]>();
  for (const r of releases) byApp.set(r.appId, [...(byApp.get(r.appId) ?? []), r]);
  const currents = apps.map((a) => currentOf(byApp.get(a.id) ?? [])).filter((r): r is ReleaseRecord => !!r);
  const ids = currents.map((r) => r.id);
  const [findings, signoffs] = await Promise.all([store.listFindings(ids), store.listSignoffs(ids)]);
  return Promise.all(apps.map(async (a) => {
    const cur = currents.find((r) => r.appId === a.id) ?? null;
    const view = cur ? releaseView(a, cur, findings, signoffs) : null;
    return { ...a, current: view, releases: byApp.get(a.id)?.length ?? 0, poll: await store.getPoll(a.id), risk: view?.scannedAt ? riskOf(view.openCounts) : "Unknown" };
  }));
}

export async function appDetail(store: Store, appId: string) {
  const app = await store.getApp(appId);
  if (!app) return null;
  const releases = await store.listReleases(appId);
  const ids = releases.map((r) => r.id);
  const [findings, signoffs, poll] = await Promise.all([store.listFindings(ids), store.listSignoffs(ids), store.getPoll(appId)]);
  return { app, releases: releases.map((r) => releaseView(app, r, findings, signoffs)), poll, currentId: currentOf(releases)?.id ?? null };
}

export async function releaseDetail(store: Store, releaseId: string) {
  const release = await store.getRelease(releaseId);
  if (!release) return null;
  const app = (await store.getApp(release.appId))!;
  const [findings, signoffs] = await Promise.all([store.listFindings([release.id]), store.listSignoffs([release.id])]);
  return { app, release: releaseView(app, release, findings, signoffs), findings, signoffs };
}

/** Fiscal year (federal: October–September) containing a date, as its ending year, e.g. FY27 for Oct 2026. */
export function fiscalYear(d: Date): number { return d.getUTCMonth() >= 9 ? d.getUTCFullYear() + 1 : d.getUTCFullYear(); }

export function kpis(apps: AppSummary[], allReleases: ReleaseRecord[], now = new Date()) {
  const fy = fiscalYear(now);
  const month = now.toISOString().slice(0, 7);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const cur = apps.map((a) => a.current).filter((r): r is ReleaseView => !!r);
  const st = (s: string) => cur.filter((r) => r.readiness.status === s);
  return {
    fiscalYear: fy,
    applications: apps.length,
    releasesThisFY: allReleases.filter((r) => fiscalYear(new Date(r.createdAt)) === fy).length,
    inReview: st("in_review").length,
    awaitingOver7Days: st("in_review").filter((r) => (r.scannedAt ?? r.createdAt) < weekAgo).length,
    inRemediation: st("in_remediation").length,
    criticalOpen: cur.reduce((n, r) => n + r.openCounts.Critical, 0),
    approved: st("approved").length,
    scheduledThisMonth: cur.filter((r) => r.readiness.status === "approved" && r.targetDate?.startsWith(month)).length,
    deployedThisMonth: allReleases.filter((r) => r.deployedAt?.startsWith(month)).length,
  };
}
