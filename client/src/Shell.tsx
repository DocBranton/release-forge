import type { ReactNode } from "react";
import type { Me } from "../../shared/types.ts";
import { Icon } from "./ui.tsx";

/** Release Forge mark: an anvil inside a ring, with a spark. Original artwork. */
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="30" fill="#13294b" stroke="#6aa8ff" strokeWidth="2" />
      <circle cx="32" cy="32" r="25" fill="none" stroke="#2f4f7f" strokeWidth="1" />
      <path d="M15 27h27c4 0 7 2 9 4-3 0-6 1-8 3l-3 3v3h4v4H22v-4h4v-3c-4-1-8-4-11-10z" fill="#e8f0fb" />
      <path d="M40 15l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="#6aa8ff" />
    </svg>
  );
}

/** Mountain ridge for the banner: two filled ranges and one drawn line. */
function Ridge() {
  return (
    <svg className="ridge" viewBox="0 0 1600 110" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <path d="M560 110 L700 52 L760 74 L860 22 L930 60 L1010 34 L1100 78 L1180 40 L1260 70 L1340 30 L1430 66 L1520 44 L1600 60 L1600 110 Z" fill="#102544" />
      <path d="M620 110 L760 70 L840 88 L940 56 L1040 92 L1120 64 L1230 96 L1320 62 L1420 90 L1500 70 L1600 84 L1600 110 Z" fill="#0d2140" />
      <path className="line" d="M560 110 L700 52 L760 74 L860 22 L930 60 L1010 34 L1100 78 L1180 40 L1260 70 L1340 30 L1430 66 L1520 44 L1600 60" fill="none" stroke="#3d6aa8" strokeWidth="1.5" />
    </svg>
  );
}

const NAV = [
  { href: "#/", key: "portfolio", label: "Portfolio", icon: Icon.portfolio },
  { href: "#/apps", key: "apps", label: "Applications", icon: Icon.apps },
  { href: "#/reviews", key: "reviews", label: "My reviews", icon: Icon.review },
  { href: "#/audit", key: "audit", label: "Audit trail", icon: Icon.audit },
];

export function Shell({ me, active, reviews, wide, side, children }: { me: Me | null; active: string; reviews: number; wide?: boolean; side?: ReactNode; children: ReactNode }) {
  const initials = (me?.email ?? me?.id ?? "?").split("@")[0].split(/[._-]/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className="shell">
      <header className="banner">
        <Ridge />
        <Mark />
        <div className="wordmark">
          <div className="name">RELEASE <span>FORGE</span></div>
          <div className="sub">SOFTWARE RELEASE ASSURANCE &amp; GOVERNANCE</div>
          <div className="tag">From code to capability: scanned, reviewed, signed off.</div>
        </div>
        <div className="platform">Integrated on<b>Databricks</b></div>
        <div className="who" title={me?.email ?? me?.id ?? ""}>
          <div className="avatar" aria-label={`Signed in as ${me?.email ?? me?.id ?? "unknown"}`}>{initials}</div>
        </div>
      </header>
      <nav className="side" aria-label="Main">
        <div className="org">U.S. AIR FORCE</div>
        <div className="nav">
          {NAV.map((n) => (
            <a key={n.key} href={n.href} aria-current={active === n.key ? "page" : undefined}>
              {n.icon}{n.label}{n.key === "reviews" && reviews > 0 && <span className="badge num">{reviews}</span>}
            </a>
          ))}
          {me?.admin && <><hr /><a href="#/apps/new" aria-current={active === "new" ? "page" : undefined}>{Icon.add}Register application</a></>}
        </div>
        <div className="motto">INTEGRITY<br />SERVICE<br />EXCELLENCE</div>
      </nav>
      <main className={`main${wide || !side ? " wide" : ""}`}>
        <div className="content">
          {me?.config?.demo && <div className="demo-band">Demo data for local development. Idea Forge II shows real findings from the 23 Oct 2026 assessment; the other applications are illustrative.</div>}
          {children}
        </div>
        {side}
      </main>
      <footer className="foot">
        <span>RELEASE FORGE</span><span>POWERED BY DATABRICKS</span><span>INTEGRATED WITH GITLAB</span>
        {me?.config?.classification && <span className="class">CLASSIFICATION: {me.config.classification}</span>}
      </footer>
    </div>
  );
}
