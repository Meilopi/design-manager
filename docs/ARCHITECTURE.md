# Cross-Product Screen Capture System on Cloudflare

## Context

We operate multiple SaaS products on Cloudflare and need one shared service that, given a user + URL, produces (a) a faithful PNG screenshot and (b) the fully rendered HTML — captured *as the authenticated user sees it*. Outputs feed QA (images) and Design (HTML). A single internal dashboard, locked down with Cloudflare Access, triggers and browses captures. This repo is a greenfield project, so we have room to pick the right primitives rather than retrofit.

Two decisions drive the rest of the design:

1. **Workflows over raw Queues for orchestration.** A capture is a multi-step, minutes-long job (acquire browser → auth → navigate → settle → snapshot → serialize → upload → notify). Cloudflare Workflows gives durable, checkpointed execution with per-step retries, which is exactly this shape. Queues remain useful as the ingestion buffer in front of Workflows for batch/backpressure/rate-limiting per product.
2. **MHTML as the HTML deliverable, not raw HTML.** Relative-vs-absolute asset rewriting is fragile. Using Chrome DevTools Protocol's `Page.captureSnapshot` ("MHTML") produces a single self-contained file with every CSS/image/font embedded, which eliminates broken-asset problems for Design. We still archive the raw outerHTML + a rewritten-URL HTML for completeness.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Admin Dashboard (React + Vite, served via Worker Assets)       │
│  Domain: capture.<yourzone>.com  (workers.dev DISABLED)         │
│  Protected by: Cloudflare Access (Zero Trust self-hosted app)   │
└─────────────────────┬───────────────────────────────────────────┘
                      │  Cf-Access-Jwt-Assertion
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│  API Worker  (Hono)                                             │
│  • Middleware: verify Access JWT against team JWKS              │
│  • RBAC via Cf-Access-Authenticated-User-Email + D1 acl table   │
│  • Routes: POST /captures, GET /captures, GET /captures/:id     │
│  • Writes job → Queue, reads state/results → D1 + R2            │
└──┬──────────────────────────────────────────────────────────────┘
   │ enqueue(job)
   ▼
┌──────────────┐     ┌───────────────────────────────────────────┐
│ capture-jobs │────▶│ Queue Consumer Worker                     │
│    Queue     │     │ • Rate-limits per product                 │
│ (batching,   │     │ • Kicks off a Workflow instance per URL   │
│  DLQ)        │     └──────────────┬────────────────────────────┘
└──────────────┘                    │ workflow.create()
                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│  Capture Workflow  (Cloudflare Workflows)                       │
│  step 1: resolve product config + fetch auth material (KV)      │
│  step 2: acquire browser session  (BrowserSessionDO)            │
│  step 3: inject cookies/headers, set viewport                   │
│  step 4: navigate with networkidle + settle heuristics          │
│  step 5: capture PNG (full-page)                                │
│  step 6: capture MHTML via CDP Page.captureSnapshot             │
│  step 7: upload PNG/MHTML/raw.html/meta.json to R2              │
│  step 8: update D1 job row + emit audit log                     │
└──────────────┬──────────────────────────────────────────────────┘
               │ (uses)
               ▼
┌──────────────────────────────┐   ┌───────────────────────────┐
│ BrowserSessionDO             │   │ R2: design-captures       │
│ (Durable Object pool)        │   │ captures/<prod>/<date>/   │
│ • Holds Puppeteer session    │   │   <jobId>/{png,mhtml,     │
│ • Reuses browser across jobs │   │   html,meta.json}         │
│ • Evicts after idle / N uses │   └───────────────────────────┘
└──────────┬───────────────────┘
           │ Browser Rendering binding
           ▼
   ┌─────────────────────┐
   │ CF Browser Rendering│
   └─────────────────────┘

D1 (control plane): jobs, products, acl, audit_log
KV (secrets):  per-product auth token templates (wrapped)
Workers Secrets: signing keys, external API keys
```

## Components

### 1. Admin Dashboard — `apps/dashboard`
- Vite + React SPA, deployed via **Workers Static Assets** (not Pages) so it sits behind the same Worker + Access policy as the API.
- Views: Trigger Capture (per-product form), Jobs List (status/filter), Job Detail (PNG preview + MHTML/HTML download), Product & ACL admin.
- No credentials in the browser — all auth handled upstream by Access.

### 2. API Worker — `workers/api`
- Framework: Hono (small, good DX on Workers).
- **Access JWT verification** middleware runs on every route: pulls `Cf-Access-Jwt-Assertion`, verifies signature against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (JWKS cached in KV), enforces `aud` claim per-application.
- **RBAC**: reads `Cf-Access-Authenticated-User-Email` → joins D1 `acl` table → `role ∈ {viewer, operator, admin}`.
- Also rejects any request missing the Access header (defense-in-depth against a misconfigured route).

### 3. Queue — `capture-jobs` + DLQ `capture-jobs-dead`
- Single queue in front of Workflows, not the orchestration engine itself.
- Consumer Worker enforces per-product concurrency caps, then creates a Workflow instance per URL. Failures after N retries land in the DLQ for manual inspection via dashboard.

### 4. Capture Workflow — `workers/capture-workflow`
- One Workflow class, steps as listed in the diagram. Each step is idempotent and checkpointed.
- **SPA settling heuristic** (step 4): `waitUntil: 'networkidle0'` + `document.readyState === 'complete'` + a configurable selector wait + a bounded MutationObserver quiet-window (e.g. "no DOM mutations for 750ms, capped at 15s"). Per-product overrides stored in D1.
- **Timeouts**: hard per-step budgets; whole workflow capped (e.g. 4 min). Cloudflare Browser Rendering sessions can run up to ~10 min on the paid plan, well inside our budget.

### 5. Browser Pool — `workers/browser-session-do`
- Durable Object wraps a long-lived Puppeteer session obtained via the Browser Rendering binding.
- Reuses the browser across N captures before recycling (significantly reduces cold start and stays well inside Browser Rendering's concurrent-browser quota on the paid plan).
- Workflow calls the DO; DO returns a "lease" scoped to one page/context.

### 6. Storage
- **R2 bucket `design-captures`**: key layout `captures/<product>/<YYYY-MM-DD>/<jobId>/{screenshot.png, snapshot.mhtml, rendered.html, meta.json}`. Object lifecycle rule: transition to infrequent access after 30d, optional deletion after 180d.
- **D1 `design_manager`**: `products`, `jobs`, `acl`, `audit_log`. Jobs table is the source of truth for UI listings.
- **KV `auth-material`**: per-product auth token templates (e.g. "paste this JWT into `Cookie: session=<token>` before capture"), stored encrypted at rest with a Workers-Secret-held key; decrypted only inside the Workflow.

### 7. Authenticated Captures (target-app auth)
- Per-product strategy record in D1 declares: `cookie | header | bearer | magic-link-endpoint`.
- Preferred path: the target product exposes a short-lived **impersonation/magic-link endpoint** callable with an operator-signed JWT. Workflow hits that endpoint to get a scoped, short-TTL session, then uses it in Puppeteer. This avoids storing live user cookies.
- Fallback: operator pastes a session token in the dashboard; stored encrypted in KV with TTL, usable exactly once per job, and every use is written to `audit_log` with the operator's Access email.

## Zero Trust Security Enforcement

- `workers_dev = false` in every wrangler config; CI check greps to prevent regression.
- Custom domain only, attached to a Cloudflare Access self-hosted application. Access policy restricts to specific email domain / IdP group.
- Worker middleware validates `Cf-Access-Jwt-Assertion` *before* any business logic; a missing/invalid JWT returns 401 even though Access should have blocked it — belt and suspenders.
- All sensitive mutations (create capture, view rendered HTML, manage ACL) are logged to `audit_log` keyed by `Cf-Access-Authenticated-User-Email`.
- Service Auth tokens for any machine-to-machine entrypoints (e.g. an ingest webhook from another product) instead of human Access policies.
- Secrets exclusively via `wrangler secret`; nothing sensitive in `wrangler.jsonc`.

## Addressing the Known Pitfalls

| Pitfall | Mitigation |
|---|---|
| Worker CPU/wall timeout | Workflows replace long-running Workers; each step is its own invocation with its own budget. Browser work happens inside Browser Rendering's own runtime. |
| SPA not fully rendered | Composite settle: `networkidle0` + `readyState` + selector wait + MutationObserver quiet window; overridable per product. |
| Broken CSS/image paths in HTML export | MHTML via CDP `Page.captureSnapshot` is the primary HTML deliverable (everything embedded). Also archive a rewritten-URL `rendered.html` with `<base href>` injected for secondary use. |
| Browser Rendering concurrency quota | DO-backed browser pool with session reuse; Queue consumer enforces per-product concurrency so one noisy product can't starve the rest. |

## Repository Layout (proposed)

```
design-manager/
├── apps/
│   └── dashboard/                 # React SPA
├── workers/
│   ├── api/                       # Hono API + Access middleware
│   ├── capture-queue-consumer/    # Queue → Workflow dispatcher
│   ├── capture-workflow/          # Workflows class
│   └── browser-session-do/        # Durable Object browser pool
├── packages/
│   ├── shared/                    # Types, Access JWT verifier, R2 key builders
│   └── product-config/            # Per-product settling + auth strategies
├── infra/
│   ├── d1/migrations/
│   └── wrangler.*.jsonc
└── package.json (pnpm workspaces)
```

## Critical Files to Create (when implementation begins)

- `workers/api/src/middleware/access.ts` — JWT verification against team JWKS (cached in KV).
- `workers/api/src/middleware/rbac.ts` — email → role lookup, route guards.
- `workers/capture-workflow/src/workflow.ts` — the step-by-step durable workflow.
- `workers/browser-session-do/src/index.ts` — DO with Puppeteer session + lease API.
- `workers/capture-workflow/src/settle.ts` — the composite SPA-ready heuristic.
- `workers/capture-workflow/src/mhtml.ts` — CDP `Page.captureSnapshot` wrapper.
- `packages/shared/src/r2-keys.ts` — deterministic object-key builder.
- `infra/d1/migrations/0001_init.sql` — `products`, `jobs`, `acl`, `audit_log`.
- Root `wrangler.jsonc` files per worker — all with `workers_dev: false`.

## Verification Plan (for later phases)

- **Local**: `wrangler dev` with Miniflare for API + DO; mock Browser Rendering with a stub session for unit tests.
- **Preview environment**: deploy to a `capture-preview.<zone>` hostname with a separate Access application; run an end-to-end test that captures a known public SPA (e.g. a small internal demo) and asserts: PNG exists in R2, MHTML opens standalone with all assets embedded, D1 job row = `completed`, audit log entry exists.
- **Access enforcement test**: `curl` the custom domain without a JWT → expect 401/redirect; `curl` with a forged JWT → expect 401 from our middleware.
- **Pitfall regression tests**: golden-file PNG diff on a fixture SPA; MHTML asset-count assertion; SPA settle heuristic test page with delayed XHR.

## Key Trade-offs Chosen

- **Workflows + Queues** (vs. Queues alone): adds one primitive but replaces bespoke retry/state code with Cloudflare-managed durable execution.
- **MHTML primary** (vs. rewritten HTML): slightly larger files, but Design never hits broken layouts.
- **DO browser pool** (vs. fresh browser per job): more code, materially better throughput within Browser Rendering quotas.
- **Workers Static Assets for UI** (vs. Pages): keeps UI + API under one Access policy/domain, simpler ZT story.
