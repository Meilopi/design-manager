import puppeteer, { type BrowserWorker, type Page } from '@cloudflare/puppeteer';

type CookieParam = Parameters<Page['setCookie']>[0];
import type { AuthPayload, CaptureJob, SettleConfig } from '@design-manager/shared';
import { runSettle } from './settle';
import { captureMhtml } from './mhtml';
import { buildSingleFile } from './single-file';
import { buildRenderedHtml } from './rendered-html';
import { buildReadme } from './readme';

export interface CaptureMeta {
  jobId: string;
  productId: string;
  userId: string;
  url: string;
  viewport: { width: number; height: number };
  settle: SettleConfig;
  capturedAt: number;
  durationMs: number;
}

export interface CaptureArtifacts {
  screenshot: Uint8Array;
  mhtml: string;
  singleFile: string;
  rendered: string;
  meta: CaptureMeta;
  readme: string;
}

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const DEFAULT_SETTLE: SettleConfig = {
  waitUntil: 'networkidle0',
  mutationQuietMs: 750,
  maxWaitMs: 15_000,
};

/**
 * Launch a fresh browser, authenticate the session, settle, capture every
 * artifact, and close the browser in a `finally` block so a failure never
 * leaks a Chromium process.
 */
export async function runCapture(
  browserBinding: BrowserWorker,
  job: CaptureJob,
  auth: AuthPayload,
  settleOverrides: Partial<SettleConfig>,
  magicLinkEndpoint: string | null,
): Promise<CaptureArtifacts> {
  const viewport = job.viewport ?? DEFAULT_VIEWPORT;
  const settle: SettleConfig = { ...DEFAULT_SETTLE, ...settleOverrides };

  const browser = await puppeteer.launch(browserBinding);
  const capturedAt = Date.now();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: viewport.width, height: viewport.height });

    await applyAuth(page, auth, job.url, magicLinkEndpoint);

    await page.goto(job.url, {
      waitUntil: settle.waitUntil,
      timeout: settle.maxWaitMs ?? 30_000,
    });
    await runSettle(page, settle);

    const screenshotData = await page.screenshot({ fullPage: true, type: 'png' });
    const screenshot = toUint8Array(screenshotData);
    const mhtml = await captureMhtml(page);
    const singleFile = await buildSingleFile(page);
    const rendered = await buildRenderedHtml(page, job.url);

    const durationMs = Date.now() - capturedAt;
    const meta: CaptureMeta = {
      jobId: job.jobId,
      productId: job.productId,
      userId: job.userId,
      url: job.url,
      viewport,
      settle,
      capturedAt,
      durationMs,
    };
    const readme = buildReadme(meta);

    return { screenshot, mhtml, singleFile, rendered, meta, readme };
  } finally {
    await browser.close();
  }
}

async function applyAuth(
  page: Page,
  auth: AuthPayload,
  url: string,
  magicLinkEndpoint: string | null,
): Promise<void> {
  if (auth.kind === 'session') {
    await applySessionCookies(page, auth.value, url);
    return;
  }

  // impersonation: preferred path is to hit the product's magic-link endpoint
  // with the JWT attached. That endpoint verifies the JWT and responds with a
  // Set-Cookie (typically followed by a 302 back into the app). Cookies stick
  // on the page's jar; we then clear the Authorization header so downstream
  // requests to job.url aren't over-authenticated.
  if (magicLinkEndpoint) {
    await page.setExtraHTTPHeaders({ Authorization: `Bearer ${auth.value}` });
    try {
      await page.goto(magicLinkEndpoint, { waitUntil: 'networkidle0', timeout: 15_000 });
    } finally {
      await page.setExtraHTTPHeaders({});
    }
    return;
  }

  // Fallback: send bearer on every request. Works for APIs that accept bearer
  // directly, but most SPAs expect cookies — prefer the magic-link flow.
  await page.setExtraHTTPHeaders({ Authorization: `Bearer ${auth.value}` });
}

async function applySessionCookies(page: Page, value: string, url: string): Promise<void> {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown;
    const cookies = (Array.isArray(parsed) ? parsed : [parsed]) as CookieParam[];
    await page.setCookie(...cookies);
    return;
  }
  const [nameValue, ...attrs] = trimmed.split(';').map((s) => s.trim());
  if (!nameValue) throw new Error('session auth value is empty');
  const eq = nameValue.indexOf('=');
  if (eq < 0) throw new Error("session auth value missing 'name=value'");
  const cookie: CookieParam = {
    name: nameValue.slice(0, eq),
    value: nameValue.slice(eq + 1),
    url,
  };
  for (const attr of attrs) {
    const [k, v] = attr.split('=').map((s) => s.trim());
    if (k?.toLowerCase() === 'domain' && v) cookie.domain = v;
    if (k?.toLowerCase() === 'path' && v) cookie.path = v;
  }
  await page.setCookie(cookie);
}

function toUint8Array(data: Uint8Array | string | Buffer): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data as ArrayBufferLike);
}
