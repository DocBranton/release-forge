// Identity comes from the Databricks Apps proxy, which authenticates every request and sets
// x-forwarded-* headers (the app is not reachable except through it).
import type { NextFunction, Request, Response } from "express";
import type { Me } from "../shared/types.ts";

export interface Actor { id: string; email: string | null }

export function identify(req: Pick<Request, "header">, env = process.env): Actor | null {
  const id = req.header("x-forwarded-user")?.trim();
  const email = (req.header("x-forwarded-email") || req.header("x-forwarded-preferred-username"))?.trim().toLowerCase() || null;
  if (id) return { id, email };
  if (env.NODE_ENV === "development") return { id: "local-dev", email: (env.RF_DEV_USER || "dev@example.mil").toLowerCase() };
  return null;
}

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** App admins come only from APP_ADMINS. There is no first-user bootstrap. */
export function isAdmin(a: Actor | null, env = process.env): boolean {
  if (!a?.email) return false;
  return list(env.APP_ADMINS).includes(a.email);
}

/** Principals (service principal application ids or emails) allowed to record deployments. Empty = any signed-in principal. */
export function isGatePrincipal(a: Actor | null, env = process.env): boolean {
  if (!a) return false;
  const allowed = list(env.RF_GATE_PRINCIPALS);
  if (!allowed.length) return true;
  return allowed.includes(a.id.toLowerCase()) || (!!a.email && allowed.includes(a.email));
}

export function me(a: Actor, env = process.env): Me { return { id: a.id, email: a.email, admin: isAdmin(a, env) }; }

declare module "express-serve-static-core" { interface Request { actor?: Actor } }

export function requireActor(req: Request, res: Response, next: NextFunction) {
  const a = identify(req);
  if (!a) { res.status(401).json({ error: "Sign in through Databricks to use Release Forge." }); return; }
  req.actor = a;
  next();
}

/** Small fixed-window rate limiter keyed by actor. */
export function rateLimit(perMinute: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.actor?.id ?? req.ip ?? "anon";
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + 60_000 }); next(); return; }
    if (++h.n > perMinute) { res.setHeader("Retry-After", String(Math.ceil((h.reset - now) / 1000))); res.status(429).json({ error: "Too many requests; try again in a minute." }); return; }
    next();
  };
}
