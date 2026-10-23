import express, { type NextFunction, type Request, type Response } from "express";
import { resolve } from "node:path";
import { requireActor } from "./auth.ts";
import type { GitLab } from "./gitlab.ts";
import { apiRouter, type UiConfig } from "./routes.ts";
import type { Store } from "./store.ts";

/** Security headers. The client is a static Vite build, so scripts load only from this origin. */
function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
    "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'self'",
  ].join("; "));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
}

export function buildApp(deps: { store: Store; gitlab: GitLab | null; publicUrl?: string; clientDir?: string; ui?: UiConfig }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(securityHeaders);
  app.get("/healthz", (_req, res) => { res.json({ ok: true }); });
  app.use("/api", express.json({ limit: "100kb" }), requireActor, apiRouter(deps));
  app.use("/api", (_req, res) => { res.status(404).json({ error: "Not found." }); });
  if (deps.clientDir) {
    const dir = deps.clientDir;
    app.use(express.static(dir, { index: false, maxAge: "1h" }));
    app.get(/.*/, (_req, res) => { res.sendFile(resolve(dir, "index.html")); });
  }
  return app;
}
