import type { AccessIdentity } from '@design-manager/shared/access-jwt';

export interface Env {
  DB: D1Database;
  JWKS_CACHE: KVNamespace;
  CAPTURES: R2Bucket;
  CAPTURE_JOBS: Queue;

  /** Static assets binding for the dashboard SPA (apps/dashboard/dist). */
  ASSETS: Fetcher;

  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;

  /** 32-byte AES-GCM key, base64url-encoded. Set via `wrangler secret put AUTH_ENC_KEY`. */
  AUTH_ENC_KEY: string;

  /**
   * Shared secret for SaaS Workers calling this API over a Service Binding
   * (Access doesn't mint a JWT when a binding skips the zone).
   * Set via `wrangler secret put INTERNAL_SERVICE_TOKEN`.
   */
  INTERNAL_SERVICE_TOKEN: string;
}

export type AppBindings = {
  Bindings: Env;
  Variables: { identity: AccessIdentity };
};
