# Release Forge

Software release assurance and governance for a portfolio of GitLab applications, running as a Databricks App.

When a team pushes to its release branch or tags a release, the project's pipeline runs Release Forge's scan jobs. Release Forge polls GitLab, pulls the raw scanner output, and turns it into one view per release: findings by category, the reviewers who still need to sign, and whether the release may deploy. The project's deploy job asks Release Forge before it runs and fails until the release is approved.

```
 GitLab project                         Databricks workspace
 ┌──────────────────────────┐           ┌──────────────────────────────────────────┐
 │ push / tag               │           │ Release Forge (Databricks App)           │
 │  └─ .pre: rf-* scan jobs │◄── poll ──│  poller ─► normalizers ─► Lakebase       │
 │      (raw JSON artifacts)│  read_api │  portfolio · release review · sign-off   │
 │  └─ deploy stage         │           │  SI Wingman (offline)                    │
 │      rf-gate ────────────┼─ OAuth ──►│  POST /api/gate/check   → allowed?       │
 │      deploy + record ────┼─ OAuth ──►│  POST /api/gate/deployed                 │
 └──────────────────────────┘           └──────────────────────────────────────────┘
```

## What it does

- **Portfolio view.** Every registered application with its current release, risk, sign-off count and an FY timeline. Filters by program, status and risk.
- **Release review.** For each release: scan results by category (Bundle Structure, SAST, SBOM, Secrets, OWASP Top 10, IaC, AV/Malware), findings with remediation guidance, sign-off status and an activity log.
- **Sign-off.** Each application chooses its required roles (Program Manager, Solution Architect, Functional Representative, Configuration Manager, Test Manager, Cyber ISSM) and lists who may sign for each.
- **Risk decisions.** The Cyber ISSM can accept the risk of a finding; the ISSM or Solution Architect can mark a false positive. Both need a written reason and carry forward to later releases with the same finding.
- **Deploy gate.** A release may deploy when all required scans ran, no blocking finding is open (Critical and High by default), and every required role has approved this exact commit.
- **SI Wingman, offline.** Answers portfolio and release questions from Release Forge's own data (delayed releases, high-risk applications, what needs my sign-off, what changed since the last release, a leadership update draft) and gives step-by-step remediation for a finding. No language model is called; `server/wingman.ts` is the seam for adding one.
- **Audit trail.** Every scan, sign-off, risk decision, gate result and deployment, with who and when.

## Rules the gate enforces

| Rule | Where |
| --- | --- |
| Sign-offs apply to one commit. A new push is a new release and needs new sign-offs. | `server/policy.ts` `latestDecisions` |
| The person who pushed the commit can't sign it. | `server/policy.ts` `isAuthor` |
| One person signs one role per release. | `server/routes.ts` sign-off route |
| Only listed reviewers sign their role; only the ISSM accepts risk. | `server/routes.ts` |
| Required scans must have run. A scanner that crashed or wrote nothing blocks; it never silently passes. | `server/normalize.ts`, `server/policy.ts` |
| A newer release supersedes older undeployed ones; the gate refuses superseded commits. | `server/store.ts` `upsertRelease` |
| Admins come only from `APP_ADMINS`. There is no first-user bootstrap. | `server/auth.ts` |

## Set it up

You need a Databricks workspace with Apps and Lakebase, and a GitLab host Release Forge can reach.

1. **Lakebase.** Create a Lakebase project (for example `release-forge`) and set `postgres_branch` / `postgres_database` in `databricks.yml`. Release Forge creates its tables in schema `release_forge` on startup.
2. **GitLab token.** Create a GitLab token with `read_api` on the groups to oversee (a group access token is best). Store it as a Databricks secret:
   ```
   databricks secrets create-scope release-forge
   databricks secrets put-secret release-forge gitlab-token
   ```
3. **Configure `app.yaml`:** `GITLAB_URL` (your GitLab host), `APP_ADMINS` (comma-separated emails), optionally `RF_CLASSIFICATION` (e.g. `CUI`) and `RF_GATE_PRINCIPALS`.
4. **Deploy:** `databricks bundle deploy -t dev && databricks bundle run release_forge -t dev`.
5. **Gate service principal.** Create a service principal for CI, give it **CAN USE** on the app, and either set up a Databricks federation policy for your GitLab projects (preferred; no stored secret) or create an OAuth secret for it. Put its application id in `RF_GATE_PRINCIPALS` so only it can record deployments.

## Onboard an application

1. In Release Forge, **Register application** (admins): name, GitLab project path, release branch, required roles and their reviewers, blocking severities and required scans.
2. In the application's `.gitlab-ci.yml`, include the template and add the gate:
   ```yaml
   include:
     - project: "<group>/release-forge"
       ref: v0.1.0
       file: "ci/release-forge.gitlab-ci.yml"

   rf-gate:
     extends: .rf-gate-oidc        # or .rf-gate with RF_SP_CLIENT_SECRET
     stage: deploy
   deploy:
     stage: deploy
     needs: [rf-gate]
     script:
       - ./deploy.sh
       - !reference [.rf-scripts, record_deploy]
   ```
3. Set the project's CI/CD variables: `RF_APP_URL`, `DATABRICKS_HOST`, `RF_SP_CLIENT_ID`, and `RF_OIDC_AUDIENCE` (federation) or `RF_SP_CLIENT_SECRET`.

The next push to the release branch appears in Release Forge within one poll (5 minutes by default), or immediately when `rf-gate` runs, since the gate fetches its own pipeline before answering. When the gate fails because sign-off is pending, re-run the job after the last reviewer signs.

### Scan jobs

| Job | Tool (pinned) | Artifact | Category |
| --- | --- | --- | --- |
| `rf-semgrep` | Semgrep 1.182.1 | `release-forge/semgrep.json` | SAST, OWASP Top 10 |
| `rf-gitleaks` | Gitleaks 8.28.0, full history | `release-forge/gitleaks.json` | Secrets |
| `rf-npm-audit` | npm audit (Node 22.22.0) | `release-forge/npm-audit.json` | SBOM |
| `rf-checkov` | Checkov 3.3.30 | `release-forge/checkov.json` | IaC |
| `rf-clamav` | ClamAV 1.4.6 | `release-forge/clamav.txt` | AV / Malware |
| `rf-bundle` | Databricks CLI 0.299.2 (SHA-256 checked) | `release-forge/bundle.txt` | Bundle Structure |

Scanner jobs never fail the pipeline themselves; Release Forge decides. Override any image with the `RF_*_IMAGE` variables, ideally pinned by digest from your approved registry.

## Develop

```
npm install
npm run dev        # API on :8000 with demo data, UI on :5173
npm test           # server tests: normalizers, policy, and an end-to-end HTTP flow
npm run typecheck
npm run build && NODE_ENV=production npm start
```

Local development uses in-memory storage and signs you in as `RF_DEV_USER` (default `dev@example.mil`). Production refuses to start without Lakebase.

## Security design

- Identity comes from the Databricks Apps proxy (`x-forwarded-*` headers); every `/api` route requires it.
- The server calls only the GitLab host in `GITLAB_URL`; applications are registered by project path, so registration can't point the server elsewhere.
- Strict Content-Security-Policy (scripts from self only; fonts are self-hosted), `nosniff`, `Referrer-Policy: no-referrer`, frame ancestors limited to self.
- Parameterized SQL throughout; JSON bodies capped at 100 KB; GitLab artifacts capped at 8 MB.
- Per-user rate limits on the Wingman and gate routes.
- Gitleaks runs with `--redact`, and Release Forge never stores secret values from its output.
- `npm audit` reports 0 vulnerabilities at the time of writing.

## Not in this version

- **Cyber Compliance / inherited controls.** The control-inheritance views need the real WDP / Databricks inheritance matrix as source data.
- **A model-backed Wingman.** The offline engine answers from data and fixed guidance.
- **Merge request previews.** Only release-branch pushes and tags become releases.
- **Notifications.** Reviewers see waiting work in My reviews and the Wingman; there are no emails yet.
