import type { BrowserWorker } from '@cloudflare/puppeteer';

export interface Env {
  DB: D1Database;
  CAPTURES: R2Bucket;
  BROWSER: BrowserWorker;

  /** 32-byte AES-GCM key, base64url, same value as in workers/api. */
  AUTH_ENC_KEY: string;
}
