#!/usr/bin/env node
/**
 * scripts/deploy.mjs
 *
 * Idempotent end-to-end deployment of the design-manager stack.
 *
 * Usage:
 *   pnpm deploy:all                     # full deploy
 *   pnpm deploy:all --plan              # show what would change, don't do it
 *
 * Requires:
 *   CLOUDFLARE_API_TOKEN   — token with Workers/D1/KV/R2/Queues Edit.
 *   CLOUDFLARE_ACCOUNT_ID  — optional; auto-discovered via /memberships.
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

// Honour HTTPS_PROXY / HTTP_PROXY so fetch() works behind corporate proxies
// or sandboxed envs — Node's native fetch doesn't pick these up on its own.
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (proxyUrl) setGlobalDispatcher(new ProxyAgent(proxyUrl));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY_RUN = process.argv.includes('--plan') || process.argv.includes('--dry-run');

const MANIFEST = {
  d1:    { name: 'design-manager' },
  kv:    { name: 'design-manager-jwks' },
  r2:    { bucket: 'design-captures' },
  queue: { main: 'capture-jobs', dlq: 'capture-jobs-dead' },
  migrationFile: 'infra/d1/migrations/0001_init.sql',
  workers: {
    // Deploy order matters: workflow first (so queue-consumer's binding resolves),
    // then queue-consumer, then api (after dashboard is built).
    workflow:      { dir: 'workers/capture-workflow',        secrets: ['AUTH_ENC_KEY'] },
    queueConsumer: { dir: 'workers/capture-queue-consumer',  secrets: [] },
    api:           { dir: 'workers/api',                     secrets: ['AUTH_ENC_KEY', 'INTERNAL_SERVICE_TOKEN'] },
  },
  // Secrets to provision when absent. AUTH_ENC_KEY is shared between api+workflow.
  secrets: {
    AUTH_ENC_KEY:           { bytes: 32, sharedAcross: ['workflow', 'api'] },
    INTERNAL_SERVICE_TOKEN: { bytes: 48, sharedAcross: ['api'] },
  },
};

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) die('CLOUDFLARE_API_TOKEN is required');

// ──────────────────────────────────────────────────────────────────────
// Tiny logger

const CYAN = '\x1b[36m', DIM = '\x1b[2m', RESET = '\x1b[0m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m';
function step(label, detail = '') {
  const pad = label.padEnd(30);
  console.log(`${CYAN}→${RESET} ${pad} ${DIM}${detail}${RESET}`);
}
function done(msg)   { console.log(`${GREEN}✓${RESET} ${msg}`); }
function warn(msg)   { console.log(`${YELLOW}⚠ ${RESET} ${msg}`); }
function die(msg)    { console.error(`✘ ${msg}`); process.exit(1); }

// ──────────────────────────────────────────────────────────────────────
// CF API helpers (idempotent discovery + creation)

const CF_API = 'https://api.cloudflare.com/client/v4';

async function cfFetch(path, init = {}) {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const errs = Array.isArray(body.errors) ? body.errors.map((e) => `${e.code}: ${e.message}`).join('; ') : `HTTP ${res.status}`;
    throw new Error(`CF API ${init.method ?? 'GET'} ${path} failed — ${errs}`);
  }
  return body.result;
}

async function discoverAccountId() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const memberships = await cfFetch('/memberships');
  if (!memberships?.length) die('No memberships visible to this token. Set CLOUDFLARE_ACCOUNT_ID explicitly.');
  if (memberships.length > 1) warn(`Token sees ${memberships.length} accounts; using the first. Set CLOUDFLARE_ACCOUNT_ID to pin.`);
  return memberships[0].account.id;
}

// ──────────────────────────────────────────────────────────────────────
// Resource ensurers — each returns the authoritative id.

async function ensureD1(accountId) {
  const list = await cfFetch(`/accounts/${accountId}/d1/database?per_page=1000`);
  const hit = list.find((d) => d.name === MANIFEST.d1.name);
  if (hit) { step(`D1 ${MANIFEST.d1.name}`, `exists (${hit.uuid})`); return hit.uuid; }
  if (DRY_RUN) { step(`D1 ${MANIFEST.d1.name}`, 'would create'); return '<new>'; }
  const created = await cfFetch(`/accounts/${accountId}/d1/database`, { method: 'POST', body: JSON.stringify({ name: MANIFEST.d1.name }) });
  step(`D1 ${MANIFEST.d1.name}`, `created (${created.uuid})`);
  return created.uuid;
}

async function ensureKv(accountId) {
  const list = await cfFetch(`/accounts/${accountId}/storage/kv/namespaces?per_page=1000`);
  const hit = list.find((n) => n.title === MANIFEST.kv.name);
  if (hit) { step(`KV ${MANIFEST.kv.name}`, `exists (${hit.id})`); return hit.id; }
  if (DRY_RUN) { step(`KV ${MANIFEST.kv.name}`, 'would create'); return '<new>'; }
  const created = await cfFetch(`/accounts/${accountId}/storage/kv/namespaces`, { method: 'POST', body: JSON.stringify({ title: MANIFEST.kv.name }) });
  step(`KV ${MANIFEST.kv.name}`, `created (${created.id})`);
  return created.id;
}

async function ensureR2(accountId) {
  const { buckets } = await cfFetch(`/accounts/${accountId}/r2/buckets`);
  if (buckets.find((b) => b.name === MANIFEST.r2.bucket)) { step(`R2 ${MANIFEST.r2.bucket}`, 'exists'); return; }
  if (DRY_RUN) { step(`R2 ${MANIFEST.r2.bucket}`, 'would create'); return; }
  await cfFetch(`/accounts/${accountId}/r2/buckets`, { method: 'POST', body: JSON.stringify({ name: MANIFEST.r2.bucket }) });
  step(`R2 ${MANIFEST.r2.bucket}`, 'created');
}

async function ensureQueue(accountId, name) {
  const list = await cfFetch(`/accounts/${accountId}/queues?per_page=1000`);
  if (list.find((q) => q.queue_name === name)) { step(`Queue ${name}`, 'exists'); return; }
  if (DRY_RUN) { step(`Queue ${name}`, 'would create'); return; }
  await cfFetch(`/accounts/${accountId}/queues`, { method: 'POST', body: JSON.stringify({ queue_name: name }) });
  step(`Queue ${name}`, 'created');
}

// ──────────────────────────────────────────────────────────────────────
// Wrangler config patching (narrow regex, preserves comments/formatting)

async function writeIds(d1Id, kvId) {
  const files = [
    ['workers/api/wrangler.jsonc',                    { d1: true, kv: true  }],
    ['workers/capture-workflow/wrangler.jsonc',       { d1: true, kv: false }],
    ['workers/capture-queue-consumer/wrangler.jsonc', { d1: true, kv: false }],
  ];
  let touched = 0;
  for (const [rel, spec] of files) {
    const path = join(ROOT, rel);
    const src = await readFile(path, 'utf8');
    let next = src;
    if (spec.d1) {
      next = next.replace(
        /("database_name"\s*:\s*"design-manager"[\s\S]*?"database_id"\s*:\s*")[^"]*(")/,
        `$1${d1Id}$2`,
      );
    }
    if (spec.kv) {
      next = next.replace(
        /("binding"\s*:\s*"JWKS_CACHE"\s*,\s*"id"\s*:\s*")[^"]*(")/,
        `$1${kvId}$2`,
      );
    }
    if (next !== src) {
      if (DRY_RUN) { step(`wrangler: ${rel}`, 'would update'); touched++; continue; }
      await writeFile(path, next);
      step(`wrangler: ${rel}`, 'updated');
      touched++;
    }
  }
  if (touched === 0) done('wrangler configs already in sync');
}

// ──────────────────────────────────────────────────────────────────────
// Shell helpers (wrangler via pnpm exec, scoped to each worker's cwd)

function sh(command, args, { cwd = ROOT, input = null, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: input ? ['pipe', 'pipe', 'inherit'] : capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
      env: process.env,
    });
    let out = '';
    if (capture || input) child.stdout.on('data', (d) => (out += d.toString()));
    if (input) { child.stdin.write(input); child.stdin.end(); }
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${command} ${args.join(' ')} exited ${code}`))));
    child.on('error', reject);
  });
}

function wranglerIn(workerKey, args, opts = {}) {
  return sh('pnpm', ['exec', 'wrangler', ...args], { cwd: join(ROOT, MANIFEST.workers[workerKey].dir), ...opts });
}

// ──────────────────────────────────────────────────────────────────────
// Migrations

async function applyMigration() {
  if (DRY_RUN) { step(`migration`, `would run ${MANIFEST.migrationFile}`); return; }
  const file = join(ROOT, MANIFEST.migrationFile);
  await wranglerIn('api', ['d1', 'execute', 'design-manager', '--remote', `--file=${file}`], { capture: true });
  step(`migration`, `applied ${MANIFEST.migrationFile}`);
}

// ──────────────────────────────────────────────────────────────────────
// Dashboard build + worker deploys

async function buildDashboard() {
  if (DRY_RUN) { step('dashboard', 'would build'); return; }
  await sh('pnpm', ['--filter', '@design-manager/dashboard', 'build'], { capture: true });
  step('dashboard', 'built');
}

async function deployWorker(workerKey) {
  if (DRY_RUN) { step(`deploy ${workerKey}`, 'would deploy'); return; }
  const out = await wranglerIn(workerKey, ['deploy'], { capture: true });
  const version = out.match(/Current Version ID:\s*([a-f0-9-]+)/)?.[1] ?? '?';
  step(`deploy ${workerKey}`, `v=${version}`);
}

// ──────────────────────────────────────────────────────────────────────
// Secrets

async function listSecretNames(workerKey) {
  try {
    const out = await wranglerIn(workerKey, ['secret', 'list'], { capture: true });
    // Wrangler prints JSON-ish: [{ name: "...", type: "secret_text" }, ...]
    const match = out.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return parsed.map((s) => s.name);
  } catch {
    return [];
  }
}

function randomB64Url(bytes) {
  return randomBytes(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function putSecret(workerKey, name, value) {
  if (DRY_RUN) { step(`secret ${name}`, `would set on ${workerKey}`); return; }
  await wranglerIn(workerKey, ['secret', 'put', name], { input: value, capture: true });
}

async function ensureSecret(name) {
  const spec = MANIFEST.secrets[name];
  const presence = {};
  for (const wk of spec.sharedAcross) presence[wk] = (await listSecretNames(wk)).includes(name);

  const allPresent = spec.sharedAcross.every((wk) => presence[wk]);
  const nonePresent = spec.sharedAcross.every((wk) => !presence[wk]);

  if (allPresent) { step(`secret ${name}`, `set on ${spec.sharedAcross.join(' + ')}`); return; }
  if (!nonePresent) {
    const partials = spec.sharedAcross.filter((wk) => presence[wk]).join(',');
    const missing = spec.sharedAcross.filter((wk) => !presence[wk]).join(',');
    die(`Secret ${name} present on [${partials}] but missing on [${missing}]. Retrieve it from the existing worker and set manually; deploy cannot reconstruct.`);
  }

  const value = randomB64Url(spec.bytes);
  for (const wk of spec.sharedAcross) await putSecret(wk, name, value);
  step(`secret ${name}`, `generated + set on ${spec.sharedAcross.join(' + ')}`);
}

// ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${DRY_RUN ? YELLOW + '(plan mode — no changes)' + RESET + '\n' : ''}`);

  const accountId = await discoverAccountId();
  step('account', accountId);

  const d1Id = await ensureD1(accountId);
  const kvId = await ensureKv(accountId);
  await ensureR2(accountId);
  await ensureQueue(accountId, MANIFEST.queue.main);
  await ensureQueue(accountId, MANIFEST.queue.dlq);

  if (!DRY_RUN) await writeIds(d1Id, kvId);
  await applyMigration();
  await buildDashboard();

  // Workers must exist before secrets can be set on them; API worker must
  // be deployed AFTER dashboard builds so the assets dir is populated.
  await deployWorker('workflow');
  await deployWorker('queueConsumer');
  await deployWorker('api');

  await ensureSecret('AUTH_ENC_KEY');
  await ensureSecret('INTERNAL_SERVICE_TOKEN');

  done(DRY_RUN ? 'plan complete' : 'deploy complete');
}

main().catch((err) => die(err.stack ?? err.message));
