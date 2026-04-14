# Integrating a product with design-manager

How to wire any app to `design-manager` so it can request authenticated
screen captures of its own pages.

---

## Prompt for the next Claude Code session

Open Claude Code with **both** repos on disk (`design-manager` + the product
repo), then paste this prompt verbatim:

```
You are integrating <PRODUCT_NAME> (this repo) with the design-manager
capture system (../design-manager).

STEP 0. Read ../design-manager/docs/INTEGRATION.md end-to-end before
writing anything. That file is the contract.

STEP 1. Audit this repo and report back:
  a. Runtime (CF Workers / Node / Next.js / Express / other) and framework.
  b. Auth system: how a user logs in, the session cookie name, where the
     session store lives (DB? signed cookie? Redis?).
  c. Public reachability: hostname, whether it sits behind Cloudflare,
     behind Access, behind a Tunnel, or is only local.
  d. Whether the app is a Cloudflare Worker on the same account as
     design-manager (if yes → Service Binding is available).

STEP 2. Propose a concrete integration plan, picking:
  - Transport: Service Binding vs HTTPS + Access Service Token.
  - Auth mode: 'session' (paste cookie, MVP) vs 'impersonation'
    (implement a magic-link endpoint).
  - Product id slug.

STOP HERE. Do not modify code until I confirm the plan.

STEP 3 (after approval). Implement the plan following the guide.
Register the product row in design-manager D1, add the magic-link
endpoint (if impersonation), share the shared secret, and add one
caller site that invokes /v1/captures. Deploy. Run an end-to-end
test using dm.lopiansky.org/jobs/<jobId> as the success signal.
```

Keep the prompt boring and explicit — it should survive any model drift.

---

## Architecture recap (one-minute read)

- `dm.lopiansky.org` — API Worker + Dashboard SPA, behind Cloudflare Access.
- `POST /v1/captures` → D1 insert → Queue `capture-jobs` → `CaptureWorkflow` →
  Browser Rendering → R2 `design-captures`.
- Two **transports** a caller can use to reach the API:
  1. **Service Binding** (same CF account, Worker → Worker). Skips the zone
     and Access entirely; auth via `X-Internal-Service-Token`.
  2. **HTTPS through Access** (any runtime, any host). Auth via
     `CF-Access-Client-Id` + `CF-Access-Client-Secret`.
- Two **auth modes** for the page being captured:
  1. **session** — a raw cookie the headless browser applies before
     navigation. No product-side code required. Great for one-off captures.
  2. **impersonation** — a product-signed short-lived JWT. The capture
     workflow pre-navigates to the product's magic-link endpoint with
     `Authorization: Bearer <jwt>`; the endpoint validates the JWT, issues
     `Set-Cookie`, and redirects. Cookies stick in the page's jar before the
     real capture URL loads.

---

## Inputs needed before you start

Answer these five; the rest is mechanical:

1. **productId** (slug `^[a-z0-9][a-z0-9-]*$`: `wine`, `patient-manager`, ...)
2. **Runtime + framework** of the product
3. **Session cookie name** + how a logged-in request looks on the wire
4. **Magic-link endpoint URL** (if impersonation) or "skip — session only"
5. **Reachability**: public host / behind Access / behind Tunnel / local only

Browser Rendering fetches the target URL from Cloudflare's edge — the host
must be reachable from the public internet. If the app sits behind Access,
issue a Service Token for the capture workflow and teach the magic-link
endpoint to accept it, OR move `/internal/impersonate` to a sub-path the
Access policy bypasses.

---

## Step 1 — register the product in D1

```sql
INSERT INTO products (id, name, auth_strategy, magic_link_endpoint, default_settle_json, created_at)
VALUES (
  'your-product-id',           -- must match productId on every /v1/captures call
  'Your Product',
  'impersonation',             -- or 'session'
  'https://app.example.com/internal/impersonate',   -- NULL if session-only
  NULL,                        -- optional JSON: {"waitUntil":"networkidle0","mutationQuietMs":750}
  unixepoch()*1000
);
```

Run remotely:

```bash
cd workers/api
wrangler d1 execute design-manager --remote --command \
  "INSERT INTO products (id,name,auth_strategy,magic_link_endpoint,default_settle_json,created_at) \
   VALUES ('your-product-id','Your Product','impersonation','https://.../internal/impersonate',NULL,unixepoch()*1000);"
```

If the workflow logs `unknown product: <id>` — this step was skipped.

---

## Step 2 — pick a transport

### 2a. Service Binding (Worker caller, same CF account)

In the **caller's** `wrangler.jsonc`:

```jsonc
"services": [
  { "binding": "DESIGN_MANAGER", "service": "design-manager-api" }
]
```

Share `INTERNAL_SERVICE_TOKEN` — the same value must exist as a Workers
secret in **both** Workers:

```bash
# If you don't know the current value, generate a new one and update both sides:
node -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'))"

# In the caller repo:
wrangler secret put INTERNAL_SERVICE_TOKEN

# In design-manager:
cd workers/api && wrangler secret put INTERNAL_SERVICE_TOKEN
```

Call it:

```ts
const res = await env.DESIGN_MANAGER.fetch('https://internal/v1/captures', {
  method: 'POST',
  headers: {
    'X-Internal-Service-Token': env.INTERNAL_SERVICE_TOKEN,
    'X-Internal-Source-Product': 'your-product-id',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    productId: 'your-product-id',
    userId: user.email,
    url: 'https://app.example.com/dashboard/42',
    viewport: { width: 1440, height: 900 },
    auth: { kind: 'impersonation', value: signedJwt },
    // or: auth: { kind: 'session', value: 'sid=abc; Domain=app.example.com; Path=/' }
  }),
});
const { jobId } = await res.json();
```

Service Binding callers bypass Cloudflare Access (they don't traverse the
zone). The internal token is the only credential checked.

### 2b. HTTPS + Access Service Token (any runtime)

Create a Service Token in the Cloudflare dashboard:

```
Zero Trust → Access → Service Auth → Service Tokens → Create
```

Attach it to the existing `design-manager` Access app policy. The policy
already accepts Service Tokens alongside SSO.

Call it:

```ts
const res = await fetch('https://dm.lopiansky.org/v1/captures', {
  method: 'POST',
  headers: {
    'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID!,
    'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ /* same CaptureRequest shape as 2a */ }),
});
```

Grant the Service Token's synthetic email the `operator` role in the
`acl` table (the token's identity is `<client-id>@access`):

```bash
wrangler d1 execute design-manager --remote --command \
  "INSERT INTO acl (email,role,created_at) VALUES \
   ('<client-id>.access@...','operator',unixepoch()*1000);"
```

The exact email the middleware sees is the JWT `email` claim Access mints
for the Service Token. If you see `not in acl`, check the D1 `audit_log`
for the failed attempt — it records the identity the middleware saw.

---

## Step 3 — implement the magic-link endpoint (impersonation only)

Required contract:

- `POST /internal/impersonate`
- Accepts `Authorization: Bearer <jwt>` — no body required
- Verifies the JWT (HS256) against a shared secret `IMPERSONATION_JWT_SECRET`
- Checks `iss === 'design-manager'`, `aud === '<your-product-id>'`, `exp` in
  the future
- Issues `Set-Cookie` for a session tied to `payload.sub`
- Returns 302 to `/` (or any page — `capture.ts` clears the auth header and
  then navigates to the real capture URL)

### Node / Next.js (app router)

```ts
// app/internal/impersonate/route.ts
import { jwtVerify } from 'jose';

export async function POST(req: Request) {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!bearer) return new Response('missing bearer', { status: 401 });

  const secret = new TextEncoder().encode(process.env.IMPERSONATION_JWT_SECRET!);
  const { payload } = await jwtVerify(bearer, secret, {
    issuer: 'design-manager',
    audience: '<your-product-id>',
  });

  const cookie = await mintSessionCookie(payload.sub as string);
  return new Response(null, {
    status: 302,
    headers: { 'Set-Cookie': cookie, Location: '/' },
  });
}
```

### Cloudflare Worker / Hono

```ts
app.post('/internal/impersonate', async (c) => {
  const bearer = c.req.header('Authorization')?.replace(/^Bearer /, '');
  if (!bearer) return c.text('missing bearer', 401);

  const { payload } = await jwtVerify(
    bearer,
    new TextEncoder().encode(c.env.IMPERSONATION_JWT_SECRET),
    { issuer: 'design-manager', audience: '<your-product-id>' },
  );

  const cookie = await mintSessionCookie(payload.sub as string);
  c.header('Set-Cookie', cookie);
  return c.redirect('/', 302);
});
```

### Express

```ts
app.post('/internal/impersonate', async (req, res) => {
  const bearer = req.get('authorization')?.replace(/^Bearer /, '');
  if (!bearer) return res.status(401).send('missing bearer');

  const secret = new TextEncoder().encode(process.env.IMPERSONATION_JWT_SECRET!);
  const { payload } = await jwtVerify(bearer, secret, {
    issuer: 'design-manager',
    audience: '<your-product-id>',
  });

  const cookie = await mintSessionCookie(payload.sub as string);
  res.setHeader('Set-Cookie', cookie).redirect(302, '/');
});
```

**Security requirements**

- MUST verify the JWT signature. Never parse and trust.
- MUST validate `iss`, `aud`, `exp`.
- MUST NOT accept cookies alone — this endpoint only makes sense with the
  bearer.
- SHOULD rate-limit or IP-allowlist. Cloudflare Browser Rendering egresses
  from a known range.
- Cookie attributes: `HttpOnly; Secure; SameSite=Lax; Path=/`.
- `Domain=` — if the capture URL is a subdomain, use a leading-dot domain
  (`Domain=.example.com`) so the cookie sticks across subdomains.

**Minting the JWT on the caller side**

The monorepo's `packages/capture-sdk/src/jwt.ts` has a dependency-free
Web Crypto HS256 signer (`signHs256Jwt`). Either:

- Copy the three files under `packages/capture-sdk/src/` into the caller, or
- Hand-roll with `jose`:

```ts
import { SignJWT } from 'jose';
const secret = new TextEncoder().encode(process.env.IMPERSONATION_JWT_SECRET!);
const jwt = await new SignJWT({ sub: userEmail })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuer('design-manager')
  .setAudience('<your-product-id>')
  .setIssuedAt()
  .setExpirationTime('60s')
  .sign(secret);
```

Share `IMPERSONATION_JWT_SECRET` as a Workers secret in the caller only —
design-manager does **not** need to know it. The product verifies its own
signatures; design-manager just forwards the bearer.

---

## Step 4 — end-to-end smoke test

```bash
curl -sS -X POST https://dm.lopiansky.org/v1/captures \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "your-product-id",
    "userId": "test@example.com",
    "url": "https://app.example.com/protected",
    "auth": { "kind": "impersonation", "value": "<fresh jwt>" }
  }'
```

Expect `202 { "jobId": "...", "status": "queued" }`. Then watch:

```
https://dm.lopiansky.org/jobs/<jobId>
```

Success: status flips `queued → running → completed` within 15–30 s,
`screenshot.png` shows the authenticated view (not the login page),
`single-file.html` renders standalone in a browser.

---

## Common pitfalls

| Symptom                                       | Cause                                           | Fix                                                     |
| --------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `unknown product: <id>` in workflow logs      | Step 1 skipped                                  | INSERT into `products`                                  |
| `not in acl` on HTTP path                     | Service Token identity not in `acl`             | INSERT into `acl` with role `operator`                  |
| Screenshot is the login page                  | Cookie didn't apply on target URL               | Match `Domain` / `Path`; for cross-subdomain use `.example.com` |
| Magic-link returns 200 but cookie doesn't stick | `SameSite=Strict` blocks the redirect flow    | `SameSite=Lax; Secure; HttpOnly`                        |
| Workflow times out at 4 min                   | Page never fires `networkidle0`                 | Switch to `domcontentloaded` + `mutationQuietMs: 500`   |
| `401 access jwt invalid: no applicable key`   | Team domain / JWKS mismatch                     | design-manager's own Access config — not product side   |
| 502 from Browser Rendering                    | Target host unreachable from edge               | Verify public DNS / Access bypass for `/internal/*`     |
| `auth.value too long`                         | Cookie string or JWT > 32 kB                    | Keep JWTs under 2 kB; trim cookie payload               |

---

## Decision tree

```
Is the caller a Cloudflare Worker on account 5af25f76...?
├── YES → Service Binding (2a). Share INTERNAL_SERVICE_TOKEN.
└── NO  → HTTPS + Access Service Token (2b). No binding setup.

Does the product already mint bearer tokens and set session cookies?
├── YES → add /internal/impersonate; use auth.kind = 'impersonation'.
└── NO  → MVP: grab a real user's cookie once from DevTools,
         fire it with auth.kind = 'session'. Add impersonation later.
```

---

## Reference — `CaptureRequest` shape

Source of truth: `packages/shared/src/schemas.ts` → `captureRequestSchema`.

```ts
{
  productId: string;                 // slug, ^[a-z0-9][a-z0-9-]*$
  userId: string;                    // shown in dashboard + audit log
  url: string;                       // https, reachable from CF edge
  viewport?: { width: number; height: number };        // default 1440×900
  settle?: {
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
    selector?: string;               // wait for this selector first
    mutationQuietMs?: number;        // N ms of DOM silence
    maxWaitMs?: number;              // hard cap (default 15s, max 60s)
  };
  auth: { kind: 'session' | 'impersonation'; value: string };
}
```

Response: `202 { jobId: string, status: 'queued' }`. Poll
`GET /v1/captures/:id` for progress; download artifacts from
`GET /v1/captures/:id/artifact/{screenshot|mhtml|singleFile|rendered|meta|readme}`.
