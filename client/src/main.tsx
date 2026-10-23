import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppSummary, Me } from "../../shared/types.ts";
import { api } from "./api.ts";
import { AppPage } from "./pages/AppPage.tsx";
import { AppForm, AuditPage, myQueue, ReviewsPage } from "./pages/Other.tsx";
import { PortfolioPage } from "./pages/Portfolio.tsx";
import { ReleasePage } from "./pages/ReleasePage.tsx";
import { Shell } from "./Shell.tsx";
import "./styles.css";
import { Wingman, type WingmanContext } from "./Wingman.tsx";

type Route =
  | { page: "portfolio" } | { page: "apps" } | { page: "new" } | { page: "app"; id: string } | { page: "edit"; id: string }
  | { page: "release"; id: string } | { page: "reviews" } | { page: "audit" } | { page: "missing" };

function parse(hash: string): Route {
  const p = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (!p.length) return { page: "portfolio" };
  if (p[0] === "apps" && !p[1]) return { page: "apps" };
  if (p[0] === "apps" && p[1] === "new") return { page: "new" };
  if (p[0] === "apps" && p[2] === "edit") return { page: "edit", id: p[1] };
  if (p[0] === "apps") return { page: "app", id: p[1] };
  if (p[0] === "releases" && p[1]) return { page: "release", id: p[1] };
  if (p[0] === "reviews") return { page: "reviews" };
  if (p[0] === "audit") return { page: "audit" };
  return { page: "missing" };
}

const PORTFOLIO_WING: WingmanContext = { subtitle: "Portfolio assistant", opening: "Portfolio summary" };

function App() {
  const [route, setRoute] = useState<Route>(() => parse(location.hash));
  const [me, setMe] = useState<Me | null>(null);
  const [meErr, setMeErr] = useState<string | null>(null);
  const [reviews, setReviews] = useState(0);
  const [wing, setWingState] = useState<WingmanContext>(PORTFOLIO_WING);
  const setWing = useCallback((c: WingmanContext) => setWingState(c), []);

  useEffect(() => {
    const on = () => { setRoute(parse(location.hash)); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => { api<Me>("/me").then(setMe).catch((e) => setMeErr((e as Error).message)); }, []);
  useEffect(() => {
    if (!me) return;
    api<{ apps: AppSummary[] }>("/portfolio").then((d) => setReviews(myQueue(d.apps, me.email).sign.length)).catch(() => {});
  }, [me, route]);
  useEffect(() => {
    if (route.page === "app") setWing({ appId: route.id, subtitle: "Application assistant", opening: "Summarize this application" });
    else if (route.page !== "release") setWing(PORTFOLIO_WING);
  }, [route, setWing]);

  const active = route.page === "app" || route.page === "edit" || route.page === "release" ? "apps" : route.page;
  const withWing = ["portfolio", "app", "release", "reviews"].includes(route.page);
  if (meErr) return <div style={{ padding: 32 }} className="err">{meErr}</div>;

  return (
    <Shell me={me} active={active} reviews={reviews} side={withWing ? <Wingman ctx={wing} /> : undefined}>
      {route.page === "portfolio" && <PortfolioPage me={me} />}
      {route.page === "apps" && <PortfolioPage me={me} listOnly />}
      {route.page === "new" && <AppForm me={me} />}
      {route.page === "edit" && <AppForm me={me} id={route.id} />}
      {route.page === "app" && <AppPage id={route.id} me={me} />}
      {route.page === "release" && <ReleasePage id={route.id} me={me} setWing={setWing} />}
      {route.page === "reviews" && <ReviewsPage me={me} />}
      {route.page === "audit" && <AuditPage />}
      {route.page === "missing" && <div className="err">That page doesn't exist. <a href="#/">Go to the portfolio</a>.</div>}
    </Shell>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
