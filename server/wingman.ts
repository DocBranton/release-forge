// SI Wingman, offline engine: answers from Release Forge's own data with fixed rules and templates.
// No model is called. A model-backed engine can implement the same interface later.
import { CATEGORIES, ROLES, type AppSummary, type Finding } from "../shared/types.ts";
import { guidanceFor } from "./remediation.ts";
import type { Store } from "./store.ts";
import { appDetail, kpis, portfolio, releaseDetail } from "./views.ts";

export interface WingmanReply { title: string; sections: { heading?: string; bullets: string[] }[]; suggestions: string[]; source: "offline" }
export interface WingmanAsk { prompt: string; appId?: string; releaseId?: string; findingId?: string }

const roleLabel = (k: string) => ROLES.find((r) => r.key === k)?.label ?? k;
const catLabel = (k: string) => CATEGORIES.find((c) => c.key === k)?.label ?? k;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const STATUS: Record<string, string> = {
  scanning: "Scanning", in_remediation: "In remediation", in_review: "In review", approved: "Approved", deployed: "Deployed", superseded: "Superseded", scan_failed: "Scan failed",
};
const today = () => new Date().toISOString().slice(0, 10);

const PORTFOLIO_SUGGESTIONS = ["Which releases are delayed?", "Show high-risk applications", "Draft leadership update", "What needs my sign-off?"];
const RELEASE_SUGGESTIONS = ["Summarize current release", "Show key findings", "What changed since the last release?", "Draft leadership update"];

export function intentOf(prompt: string): string {
  const p = prompt.toLowerCase();
  if (/delay|late|overdue|slip|past due/.test(p)) return "delayed";
  if (/high[- ]risk|riskiest|risk/.test(p) && !/accept/.test(p)) return "risk";
  if (/leadership|update|brief|sitrep|status report/.test(p)) return "leadership";
  if (/sign[- ]?off|approv|my review|waiting on me/.test(p)) return "signoff";
  if (/changed|diff|since|new findings|resolved/.test(p)) return "changed";
  if (/fix|remediat|how do i|guidance|resolve this/.test(p)) return "remediate";
  if (/finding|issue|vuln/.test(p)) return "findings";
  if (/summar|overview|where are we|status/.test(p)) return "summary";
  return "help";
}

export class OfflineWingman {
  constructor(private store: Store) {}

  async ask(q: WingmanAsk, me: { email: string | null }): Promise<WingmanReply> {
    const intent = intentOf(q.prompt);
    if (q.findingId) return this.remediate(q.findingId);
    if (q.releaseId) {
      if (intent === "changed") return this.changed(q.releaseId);
      if (intent === "findings" || intent === "remediate") return this.keyFindings(q.releaseId);
      if (intent === "leadership") return this.leadership(q.appId);
      return this.releaseSummary(q.releaseId);
    }
    const apps = await portfolio(this.store);
    const scoped = q.appId ? apps.filter((a) => a.id === q.appId) : apps;
    switch (intent) {
      case "delayed": return this.delayed(scoped);
      case "risk": return this.highRisk(scoped);
      case "leadership": return this.leadership(q.appId);
      case "signoff": return this.mySignoffs(scoped, me.email);
      case "summary": return this.portfolioSummary(scoped);
      default: return this.help(!!q.appId);
    }
  }

  private help(app: boolean): WingmanReply {
    return {
      title: "Here's what I can do",
      sections: [{ bullets: [
        "Summarize the portfolio or a release, and list key findings.",
        "Find delayed releases and high-risk applications.",
        "Tell you which sign-offs are waiting on you.",
        "Explain how to fix a finding (open a finding and ask).",
        "Draft a leadership update from current data.",
      ] }, { bullets: ["I'm running offline: answers come from Release Forge's own data and fixed guidance, not a language model."] }],
      suggestions: app ? RELEASE_SUGGESTIONS : PORTFOLIO_SUGGESTIONS, source: "offline",
    };
  }

  private async releasesOf(apps: AppSummary[]) {
    const ids = new Set(apps.map((a) => a.id));
    return (await this.store.listReleases()).filter((r) => ids.has(r.appId));
  }

  async portfolioSummary(apps: AppSummary[]): Promise<WingmanReply> {
    const k = kpis(apps, await this.releasesOf(apps));
    const high = apps.filter((a) => a.risk === "High").map((a) => a.name);
    const one = apps.length === 1 ? apps[0] : null;
    if (one) {
      const r = one.current;
      return {
        title: `${one.name}${r ? ` ${r.version}: ${STATUS[r.readiness.status]}` : ""}`,
        sections: [
          { bullets: r ? [
            `${plural(k.releasesThisFY, "release")} scanned this fiscal year; ${k.deployedThisMonth} deployed this month.`,
            `Current release has ${r.openCounts.Critical} critical, ${r.openCounts.High} high and ${r.openCounts.Medium} medium findings open.`,
            `${r.readiness.approvedRoles.length} of ${one.requiredRoles.length} sign-offs complete.`,
            r.targetDate ? `Target deployment ${r.targetDate}${r.targetDate < today() && !r.deployedAt ? " (past due)" : ""}.` : "No target deployment date set.",
          ] : ["No release pipeline has been ingested yet. Check the project includes the Release Forge CI template."] },
          ...(r?.readiness.reasons.length ? [{ heading: "What's blocking deployment", bullets: r.readiness.reasons.slice(0, 4) }] : []),
        ],
        suggestions: RELEASE_SUGGESTIONS.filter((x) => !/changed/.test(x)), source: "offline",
      };
    }
    return {
      title: `Portfolio summary, FY${String(k.fiscalYear).slice(2)}`,
      sections: [
        { bullets: [
          `${plural(k.applications, "application")}, ${plural(k.releasesThisFY, "release")} scanned this fiscal year.`,
          `${k.inReview} in review (${k.awaitingOver7Days} waiting more than 7 days).`,
          `${k.inRemediation} in remediation${k.criticalOpen ? ` (${plural(k.criticalOpen, "open critical finding")})` : ""}.`,
          `${k.approved} approved, ${k.scheduledThisMonth} scheduled to deploy this month, ${k.deployedThisMonth} deployed this month.`,
        ] },
        { heading: "Key insights", bullets: [
          high.length ? `Highest risk: ${high.join(", ")}.` : "No application has open critical or high findings.",
          ...this.delayedLines(apps).slice(0, 3),
        ] },
      ],
      suggestions: PORTFOLIO_SUGGESTIONS, source: "offline",
    };
  }

  private delayedLines(apps: AppSummary[]): string[] {
    return apps.filter((a) => a.current?.targetDate && a.current.targetDate < today() && !a.current.deployedAt)
      .map((a) => `${a.name} ${a.current!.version} was due ${a.current!.targetDate} and is ${STATUS[a.current!.readiness.status].toLowerCase()}.`);
  }

  delayed(apps: AppSummary[]): WingmanReply {
    const lines = this.delayedLines(apps);
    return {
      title: lines.length ? `${plural(lines.length, "release")} past target date` : "No releases are past their target date",
      sections: [{ bullets: lines.length ? lines : ["Every current release with a target date is on schedule or deployed."] }],
      suggestions: PORTFOLIO_SUGGESTIONS, source: "offline",
    };
  }

  highRisk(apps: AppSummary[]): WingmanReply {
    const hi = apps.filter((a) => a.risk === "High").sort((a, b) => (b.current!.openCounts.Critical - a.current!.openCounts.Critical) || (b.current!.openCounts.High - a.current!.openCounts.High));
    return {
      title: hi.length ? `${plural(hi.length, "high-risk application")}` : "No high-risk applications",
      sections: [{ bullets: hi.length
        ? hi.map((a) => `${a.name} ${a.current!.version}: ${a.current!.openCounts.Critical} critical, ${a.current!.openCounts.High} high open. ${a.current!.readiness.reasons[0] ?? ""}`.trim())
        : ["No current release has open critical or high findings."] }],
      suggestions: PORTFOLIO_SUGGESTIONS, source: "offline",
    };
  }

  mySignoffs(apps: AppSummary[], email: string | null): WingmanReply {
    const e = email?.toLowerCase();
    const mine = apps.flatMap((a) => {
      const r = a.current;
      if (!e || !r || r.readiness.status !== "in_review") return [];
      const roles = r.readiness.missingRoles.filter((role) => (a.reviewers[role] ?? []).includes(e));
      // One person signs one role per release, so a release is one item even if they're listed for several roles.
      return roles.length ? [`${a.name} ${r.version}: ${roles.map(roleLabel).join(" or ")}`] : [];
    });
    return {
      title: mine.length ? `${plural(mine.length, "sign-off")} waiting on you` : "Nothing is waiting on your sign-off",
      sections: [{ bullets: mine.length ? mine : ["You are not an outstanding reviewer on any release in review."] }],
      suggestions: PORTFOLIO_SUGGESTIONS, source: "offline",
    };
  }

  async releaseSummary(releaseId: string): Promise<WingmanReply> {
    const d = await releaseDetail(this.store, releaseId);
    if (!d) return this.help(true);
    const r = d.release, c = r.openCounts;
    const approved = r.readiness.approvedRoles.length, need = d.app.requiredRoles.length;
    return {
      title: `${d.app.name} ${r.version}: ${STATUS[r.readiness.status]}`,
      sections: [
        { bullets: [
          `${c.Critical} critical, ${c.High} high, ${c.Medium} medium open findings.`,
          `${approved} of ${need} sign-offs complete.`,
          r.targetDate ? `Target deployment ${r.targetDate}${r.targetDate < today() && !r.deployedAt ? " (past due)" : ""}.` : "No target deployment date set.",
          `Scanned ${r.scannedAt ? r.scannedAt.slice(0, 16).replace("T", " ") + " UTC" : "not yet"} from commit ${r.sha.slice(0, 8)}.`,
        ] },
        ...(r.readiness.reasons.length ? [{ heading: "What's blocking deployment", bullets: r.readiness.reasons }] : [{ heading: "Ready", bullets: ["All required scans ran, nothing blocking is open, and every required role has signed."] }]),
        { heading: "Suggested actions", bullets: this.actions(r.readiness.status, r.readiness.missingRoles) },
      ],
      suggestions: RELEASE_SUGGESTIONS, source: "offline",
    };
  }

  private actions(status: string, missing: string[]): string[] {
    if (status === "in_remediation") return ["Open the blocking findings and fix them, or ask the Cyber ISSM to accept the risk with a written reason.", "Push the fix; the next pipeline is picked up automatically."];
    if (status === "in_review") return [`Remind ${missing.map(roleLabel).join(", ") || "reviewers"} to sign.`, "Confirm the deployment window."];
    if (status === "approved") return ["Run the deploy job; the gate will pass for this commit."];
    if (status === "scanning") return ["Wait for the pipeline's scan jobs to finish, or use Poll now on the application page."];
    return ["Check the pipeline includes the Release Forge CI template."];
  }

  async keyFindings(releaseId: string): Promise<WingmanReply> {
    const d = await releaseDetail(this.store, releaseId);
    if (!d) return this.help(true);
    const open = d.findings.filter((f) => f.state === "open").slice(0, 6);
    return {
      title: open.length ? "Highest-risk open findings" : "No open findings",
      sections: [{ bullets: open.length ? open.map((f) => `${f.severity} · ${catLabel(f.category)}: ${f.title} (${f.path}${f.line ? `:${f.line}` : ""})`) : ["Every finding is fixed, accepted or marked a false positive."] }],
      suggestions: ["How do I fix the top finding?", ...RELEASE_SUGGESTIONS.slice(0, 2)], source: "offline",
    };
  }

  async changed(releaseId: string): Promise<WingmanReply> {
    const d = await appDetail(this.store, (await this.store.getRelease(releaseId))?.appId ?? "");
    if (!d) return this.help(true);
    const idx = d.releases.findIndex((r) => r.id === releaseId);
    const prev = d.releases.slice(idx + 1).find((r) => r.scannedAt);
    if (!prev) return { title: "No earlier scanned release to compare with", sections: [{ bullets: ["This is the first scanned release of this application."] }], suggestions: RELEASE_SUGGESTIONS, source: "offline" };
    const [now, before] = await Promise.all([this.store.listFindings([releaseId]), this.store.listFindings([prev.id])]);
    const prevFp = new Set(before.map((f) => f.fingerprint)), nowFp = new Set(now.map((f) => f.fingerprint));
    const added = now.filter((f) => !prevFp.has(f.fingerprint)), gone = before.filter((f) => !nowFp.has(f.fingerprint));
    const line = (f: Finding) => `${f.severity}: ${f.title} (${f.path})`;
    return {
      title: `Since ${prev.version}`,
      sections: [
        { heading: `${plural(added.length, "new finding")}`, bullets: added.slice(0, 8).map(line).concat(added.length > 8 ? [`…and ${added.length - 8} more`] : []) },
        { heading: `${plural(gone.length, "finding")} resolved`, bullets: gone.slice(0, 8).map(line).concat(gone.length > 8 ? [`…and ${gone.length - 8} more`] : []) },
      ].filter((s) => s.bullets.length),
      suggestions: RELEASE_SUGGESTIONS, source: "offline",
    };
  }

  async remediate(findingId: string): Promise<WingmanReply> {
    const f = await this.store.getFinding(findingId);
    if (!f) return this.help(true);
    const g = guidanceFor(f);
    return {
      title: `How to fix: ${f.title}`,
      sections: [
        { bullets: [g.summary, `${f.tool} · ${f.rule} · ${f.path}${f.line ? `:${f.line}` : ""}`] },
        { heading: "Steps", bullets: g.steps },
        { heading: "Verify", bullets: [g.verify] },
        { heading: "References", bullets: g.references },
      ],
      suggestions: ["Show key findings", "Summarize current release"], source: "offline",
    };
  }

  async leadership(appId?: string): Promise<WingmanReply> {
    const apps = (await portfolio(this.store)).filter((a) => !appId || a.id === appId);
    const k = kpis(apps, await this.releasesOf(apps));
    const blocked = apps.filter((a) => a.current?.readiness.status === "in_remediation");
    const ready = apps.filter((a) => a.current?.readiness.status === "approved");
    return {
      title: "Draft leadership update",
      sections: [
        { bullets: [
          `Release Forge is tracking ${plural(k.applications, "application")}. This fiscal year we have scanned ${plural(k.releasesThisFY, "release")} and deployed ${k.deployedThisMonth} this month.`,
          ready.length ? `Ready to deploy: ${ready.map((a) => `${a.name} ${a.current!.version}`).join(", ")}.` : "No releases are fully approved yet.",
          blocked.length ? `In remediation: ${blocked.map((a) => `${a.name} (${a.current!.openCounts.Critical} critical, ${a.current!.openCounts.High} high)`).join("; ")}.` : "No releases are blocked by security findings.",
          k.awaitingOver7Days ? `${plural(k.awaitingOver7Days, "release")} have waited more than 7 days for sign-off.` : "No sign-offs are more than 7 days old.",
          ...this.delayedLines(apps).slice(0, 3),
        ] },
        { bullets: ["[Add mission impact and decisions needed from leadership.]"] },
      ],
      suggestions: PORTFOLIO_SUGGESTIONS, source: "offline",
    };
  }
}

