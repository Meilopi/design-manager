# Cross-Product Screen Capture System on Cloudflare

## Context

We operate multiple SaaS products on Cloudflare and need one shared service that, given a user + URL, produces (a) a faithful PNG screenshot and (b) the fully rendered HTML — captured *as the authenticated user sees it*. Outputs feed QA (images) and Design (HTML). A single internal dashboard, locked down with Cloudflare Access, triggers and browses captures. This repo is a greenfield project, so we have room to pick the right primitives rather than retrofit.

Core decisions:

1. **Workflows over raw Queues for orchestration.** A capture is a multi-step, minutes-long job (acquire browser → auth → navigate → settle → snapshot → serialize → upload → notify). Cloudflare Workflows gives durable, checkpointed execution with per-step retries, which is exactly this shape. Queues remain useful as the ingestion buffer in front of Workflows for batch/backpressure/rate-limiting per product.
2. **Three HTML deliverables, not one.** MHTML alone is not friendly to Figma-style design tools. We produce **(a) `snapshot.mhtml`** (fidelity archive, opens in Chromium), **(b) `single-file.html`** (self-contained HTML with every asset inlined as data-URI, opens in any browser and suitable for SingleFile-style tooling), and **(c) `rendered.html`** (raw outerHTML with `<base href>` injected). Plus the PNG. A small `README.md` is generated inside every capture folder explaining which file to use for which purpose.
3. **Auth material rides inside the Workflow payload, not KV.** KV's eventual consistency (up to ~60s global) is disqualifying for short-TTL tokens consumed seconds after issuance. Encrypted auth material is passed directly as a Workflow param (durably persisted with the instance, immediately readable) and decrypted only inside the step that needs it.
4. **Start without a browser pool.** Fresh browser per workflow is the default. We upgrade to a DO-backed pool only if Browser Rendering quota or latency metrics force it (see §5).

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
│  • Encrypts auth payload, writes job → Queue, reads D1 + R2     │
└──┬──────────────────────────────────────────────────────────────┘
   │ enqueue(job {encryptedAuth})              ▲  service binding
   ▼                                           │  from SaaS Workers
┌──────────────┐     ┌───────────────────────────────────────────┐
│ capture-jobs │────▶│ Queue Consumer Worker                     │
│    Queue     │     │ • Rate-limits per product                 │
│ (batching,   │     │ • Kicks off a Workflow instance per URL   │
│  DLQ)        │     │   passing encryptedAuth as a param        │
└──────────────┘     └──────────────┬────────────────────────────┘
                                    │ workflow.create({params})
                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│  Capture Workflow  (Cloudflare Workflows)                       │
│  step 1: resolve product config (D1) + decrypt auth param       │
│  step 2: launch fresh browser (Browser Rendering binding)       │
│  step 3: inject cookies/headers, set viewport                   │
│  step 4: navigate with networkidle + settle heuristics          │
│  step 5: capture PNG (full-page + viewport)                     │
│  step 6: capture MHTML (CDP Page.captureSnapshot)               │
│  step 7: build single-file.html (inline all assets as data-URI) │
│  step 8: upload {png,mhtml,single-file.html,rendered.html,      │
│          meta.json,README.md} to R2                             │
│  step 9: update D1 job row + emit audit log                     │
│  finally: browser.close()                                       │
└──────────────┬──────────────────────────────────────────────────┘
               │
               ▼
   ┌────────────────────────────────────────────────┐
   │ R2: design-captures                            │
   │ captures/<product>/<YYYY-MM-DD>/<jobId>/…      │
   └────────────────────────────────────────────────┘

D1 (control plane + ephemeral auth scratchpad):
    products, jobs, acl, audit_log, auth_grants(ttl)
KV:    JWKS cache only (rotation is slow; consistency is fine here)
Workers Secrets: JWT signing keys, auth-payload encryption key
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
- **Three HTML outputs** (steps 6–7) — see §6 for how each is built and when Design should use which.
- **Timeouts**: hard per-step budgets; whole workflow capped (e.g. 4 min). Cloudflare Browser Rendering sessions can run up to ~10 min on the paid plan, well inside our budget.
- **Browser lifecycle**: one fresh browser per workflow instance, closed in a `finally`-style cleanup step so a failure never leaks a session.

### 5. Browser Lifecycle — start simple, pool only if proven necessary
**Default (Phase 1): fresh browser per workflow.** Justification for the simplification:
- No lease coordination, no idle-eviction timer, no per-DO memory-leak surface, no split-brain if a DO is evicted mid-job.
- `browser.close()` in a `finally` step is all the cleanup we need; CF reclaims the Chromium process.
- Paid-plan Browser Rendering quotas (concurrent browsers + launches/minute) are more than adequate for an internal tool triggered by humans or a modest queue. Queue consumer concurrency caps keep us comfortably under the quota ceiling.

**Upgrade trigger.** Only introduce a Durable Object browser pool (`workers/browser-session-do`, deferred to Phase 2) if one of these metrics actually fires in production:
- Sustained p95 capture latency dominated by browser cold-start (> ~2–3 s of the total).
- Browser Rendering launch-rate quota throttles appearing in logs.
- Queue backlog growing faster than it drains under expected load.

**If we do build the pool later**, the cleanup/recycle contract is: (i) each DO holds one browser and a monotonically-increasing `usesRemaining` counter; (ii) leases return an isolated `BrowserContext` (not a shared page); (iii) on lease release we always close the context; (iv) we recycle the browser after N uses *or* T seconds of idle *or* any error; (v) a Cron Trigger reaps DOs that missed their idle timer.

### 6. Storage & Output Formats
- **R2 bucket `design-captures`**, key layout `captures/<product>/<YYYY-MM-DD>/<jobId>/`:
  | File | Purpose | How it's produced | Primary consumer |
  |---|---|---|---|
  | `screenshot.png` | QA image, full-page + viewport variants | Puppeteer `page.screenshot` | QA, Figma import |
  | `snapshot.mhtml` | High-fidelity archive | CDP `Page.captureSnapshot` | Anyone on Chromium |
  | `single-file.html` | Self-contained HTML, every CSS/image/font/svg inlined as data-URI | In-page script: walk DOM, fetch + base64 each referenced asset via Puppeteer, rewrite attributes, serialize | **Default Design deliverable** — opens in any browser, editable in VS Code, suitable for SingleFile-compatible extractors |
  | `rendered.html` | Raw outerHTML with injected `<base href>` and absolute-URL rewrites | `page.content()` + URL rewrite pass | Fallback / debugging |
  | `meta.json` | URL, viewport, timings, user email, settle strategy used, SHA-256 of each artifact | Workflow metadata | Audit + UI |
  | `README.md` | Generated per-capture: which file is for whom, how to open MHTML, note on data-URI inlining | Template rendered at upload time | Design team onboarding |
- Lifecycle rule: transition to infrequent access after 30d; optional deletion after 180d.
- **D1 `design_manager`**: `products`, `jobs`, `acl`, `audit_log`, `auth_grants`. Jobs table is the source of truth for UI listings. `auth_grants` is the strongly-consistent scratchpad for short-TTL, one-shot auth material (see §7).
- **KV**: JWKS cache only — eventual consistency is acceptable because JWKS rotation is slow and verifiers can fall back to a direct JWKS fetch on cache miss.

### 7. Authenticated Captures (target-app auth) — *revised*
- Per-product strategy record in D1 declares: `cookie | header | bearer | magic-link-endpoint`.
- **Primary path (preferred)**: target SaaS product exposes a short-lived **impersonation/magic-link endpoint** callable with an operator-signed JWT. The Capture Workflow calls the endpoint *inside* step 1 to mint a scoped, short-TTL session, then uses it in Puppeteer. No persistence of user cookies at all.
- **Transport of auth material: Workflow params, not KV.** The API Worker encrypts the auth payload with a Workers-Secret-held key (AES-GCM), attaches the ciphertext to the job message and subsequently the Workflow params. The Workflow decrypts in-memory inside step 1; the ciphertext is durably persisted as part of the Workflow instance (immediately readable, no global propagation delay).
- **Optional D1 auth_grants table**: for flows where the caller cannot or should not carry the secret through the queue (e.g. very large tokens, or a UI-triggered capture where the operator pastes a cookie), the API Worker writes a one-shot row `auth_grants(grant_id, ciphertext, expires_at, consumed_at)` and passes only the `grant_id` through. D1 is strongly consistent on the primary, so the Workflow reads-then-marks-consumed within milliseconds. Any attempt to re-read after `consumed_at` is rejected.
- **Never KV** for ephemeral auth — its eventual consistency window is a usability and security hazard here.
- Every decrypt/consume is written to `audit_log` with the originating Access email (for UI triggers) or the SaaS product + end-user ID (for SaaS-initiated captures).

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
| Broken CSS/image paths in HTML export | Three formats produced per capture — MHTML (fidelity archive), `single-file.html` with every asset inlined as data-URI (design tool–friendly, opens in any browser), and `rendered.html` with `<base href>` (debug/fallback). Per-capture `README.md` documents which file to use. |
| KV eventual consistency for ephemeral auth | Auth ciphertext travels inside the Workflow param payload; strongly-consistent D1 `auth_grants` is the optional scratchpad. KV is reserved for slow-moving data (JWKS). |
| Browser Rendering concurrency quota | Queue consumer enforces per-product concurrency caps; fresh-browser-per-workflow keeps utilization predictable. DO-backed pool is the fallback if metrics demand it. |

## SaaS Worker Integration

This system must plug into existing CF Workers SaaS products with minimal friction. The integration has three layers: a triggering channel, an auth-handoff contract, and a small shared SDK that hides both.

### 8.1 Triggering channels (pick one per call-site)

| Channel | When to use | How | Auth between caller and capture |
|---|---|---|---|
| **Workers Service Binding** (preferred) | SaaS Worker lives in the *same* CF account as `workers/api` | Bind `CAPTURE_API` in the SaaS `wrangler.jsonc`; call `env.CAPTURE_API.fetch(req)` | Shared `INTERNAL_SERVICE_TOKEN` header (bindings skip the zone, so Access can't sign a JWT). Token rotates via `wrangler secret put`. |
| **Queue producer binding** | Fire-and-forget, high-volume, SaaS Worker doesn't need the job ID synchronously | Bind `CAPTURE_JOBS` queue in SaaS; `env.CAPTURE_JOBS.send(job)` | Same account; platform-level |
| **HTTPS + Cloudflare Access Service Token** | SaaS Worker in a different account / zone | `fetch('https://capture.<zone>/v1/captures', { headers: { 'CF-Access-Client-Id': …, 'CF-Access-Client-Secret': … } })` | Service Token policy on the same Access application that gates humans |

All three channels converge on the same API Worker code path. The middleware accepts either a valid `Cf-Access-Jwt-Assertion` (humans or zone-traversing Service Tokens) *or* a valid `X-Internal-Service-Token` (Service Binding callers). The Service Binding path also sends `X-Internal-Source-Product` for audit tagging.

`workers.dev` stays disabled on every surface; these channels are how calls legitimately reach the API.

### 8.2 Auth handoff contract

The capture request from a SaaS Worker carries exactly one of:

1. **An impersonation JWT** (recommended): SaaS Worker signs a short-TTL (≤ 60 s) JWT with a **shared HMAC/Ed25519 key** registered in the capture system's `products` row. Claims: `{ sub: userId, aud: "capture", productId, scope, exp }`. The Capture Workflow presents this JWT to the target product's magic-link endpoint (see §7) in exchange for a scoped session cookie. No user cookies are exfiltrated from the SaaS Worker at all.
2. **An encrypted session blob** (fallback): SaaS Worker gathers the minimum viable session material (e.g. a scoped session cookie it just minted for this capture) and encrypts it *client-side* with the capture system's public key (the SDK handles this), attaching the ciphertext to the request. The API Worker re-encrypts under its own symmetric key before queuing; no plaintext crosses the queue.

Either way, the capture request body is:

```
{ productId, userId, url, viewport?, settle?, auth: { kind: "impersonation" | "session", payload: "..." } }
```

…and the SaaS Worker never ships anything that persists beyond the single job.

### 8.3 Pluggable SDK — `packages/capture-sdk`

A tiny internal package so SaaS teams integrate in ~10 lines:

```
import { createCaptureClient } from "@internal/capture-sdk";

const capture = createCaptureClient({
  binding: env.CAPTURE_API,       // or: { url, serviceToken }
  productId: "billing-app",
  signingKey: env.CAPTURE_IMPERSONATION_KEY, // Workers Secret
});

await capture.request({
  userId: user.id,
  url: targetUrl,
  viewport: { width: 1440, height: 900 },
});
```

The SDK handles: Zod-validated types, JWT minting for impersonation, envelope encryption for the fallback path, retries with jitter, and surfacing the `jobId` for polling or webhook callback. It ships as an internal workspace package; each SaaS consumes it with a single `pnpm add` and a `wrangler.jsonc` binding update.

### 8.4 Product onboarding checklist
1. Add a `products` row in D1: `id`, `name`, `authStrategy`, `magicLinkEndpoint`, `signingPublicKey`, `concurrencyCap`, `defaultSettle`.
2. In the SaaS Worker: bind `CAPTURE_API` (or queue), install `@internal/capture-sdk`, set the `CAPTURE_IMPERSONATION_KEY` secret.
3. Add an impersonation/magic-link endpoint in the SaaS Worker that accepts the impersonation JWT and returns a short-TTL session cookie for the specified user + scope.
4. Smoke-test by hitting the preview environment; the capture appears in the dashboard under that product.

## Repository Layout (proposed)

```
design-manager/
├── apps/
│   └── dashboard/                      # React SPA
├── workers/
│   ├── api/                            # Hono API + Access middleware
│   ├── capture-queue-consumer/         # Queue → Workflow dispatcher
│   ├── capture-workflow/               # Workflows class (fresh browser per instance)
│   └── browser-session-do/             # (Phase 2, only if metrics require it)
├── packages/
│   ├── shared/                         # Types, Access JWT verifier, crypto helpers, R2 keys
│   ├── capture-sdk/                    # Consumed by every SaaS Worker
│   └── product-config/                 # Per-product settling + auth strategies
├── infra/
│   ├── d1/migrations/
│   └── wrangler.*.jsonc
└── package.json (pnpm workspaces)
```

## Critical Files to Create (when implementation begins)

- `workers/api/src/middleware/access.ts` — JWT verification against team JWKS (KV-cached) accepting both human and Service Token JWTs.
- `workers/api/src/middleware/rbac.ts` — email → role lookup, route guards.
- `workers/api/src/routes/captures.ts` — POST / GET / GET-by-id; encrypts auth payload onto the job.
- `workers/capture-workflow/src/workflow.ts` — step-by-step durable workflow with `finally` browser close.
- `workers/capture-workflow/src/settle.ts` — composite SPA-ready heuristic.
- `workers/capture-workflow/src/mhtml.ts` — CDP `Page.captureSnapshot` wrapper.
- `workers/capture-workflow/src/single-file.ts` — in-page asset walker + data-URI inliner producing `single-file.html`.
- `workers/capture-workflow/src/readme.ts` — per-capture README.md generator.
- `packages/shared/src/crypto.ts` — AES-GCM envelope encrypt/decrypt for auth payloads.
- `packages/shared/src/r2-keys.ts` — deterministic object-key builder.
- `packages/capture-sdk/src/index.ts` — `createCaptureClient`, `mintImpersonationJwt`, Zod schemas.
- `infra/d1/migrations/0001_init.sql` — `products`, `jobs`, `acl`, `audit_log`, `auth_grants`.
- Root `wrangler.jsonc` files per worker — all with `workers_dev: false`.

## Verification Plan (for later phases)

- **Local**: `wrangler dev` with Miniflare for API; mock Browser Rendering with a stub session for unit tests.
- **Preview environment**: deploy to a `capture-preview.<zone>` hostname with a separate Access application; run an end-to-end test that captures a known public SPA and asserts: PNG exists in R2, MHTML opens standalone, `single-file.html` opens offline with all assets rendered, D1 job row = `completed`, audit log entry exists.
- **Access enforcement test**: `curl` the custom domain without a JWT → expect 401/redirect; `curl` with a forged JWT → expect 401 from our middleware; `curl` with a valid Service Token → expect success.
- **SaaS-integration smoke test**: from a throwaway SaaS Worker, use the SDK with (a) service binding and (b) Service Token paths; both produce identical captures.
- **Pitfall regression tests**: golden-file PNG diff on a fixture SPA; `single-file.html` opens with `file://` scheme and every `<img>`, `<link rel="stylesheet">`, and `@font-face` resolves without network; SPA settle heuristic test page with delayed XHR.
- **Auth-consistency test**: issue a job whose auth grant is read immediately after creation; Workflow succeeds on first attempt (validates we didn't regress onto KV).

## Key Trade-offs Chosen

- **Workflows + Queues** (vs. Queues alone): adds one primitive but replaces bespoke retry/state code with Cloudflare-managed durable execution.
- **Three HTML outputs** (vs. MHTML only): slightly more storage, but Design actually gets a file their tools can ingest.
- **Fresh browser per workflow** (vs. DO pool up front): less code, no lease/leak surface; pool is deferred behind an explicit metrics trigger.
- **Auth ciphertext in Workflow params + D1 auth_grants** (vs. KV): strong consistency, no propagation delay, no stale reads.
- **Workers Static Assets for UI** (vs. Pages): keeps UI + API under one Access policy/domain, simpler ZT story.
- **Service Binding + Service Token** (vs. one transport only): same-account integrations get zero-overhead calls; cross-account SaaS still has a first-class path.
