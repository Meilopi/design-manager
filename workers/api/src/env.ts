import type { AccessIdentity } from '@design-manager/shared';

export interface Env {
  DB: D1Database;
  JWKS_CACHE: KVNamespace;
  CAPTURES: R2Bucket;
  CAPTURE_JOBS: Queue;

  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;

  /** 32-byte AES-GCM key, base64url-encoded. Set via `wrangler secret put AUTH_ENC_KEY`. */
  AUTH_ENC_KEY: string;
}

export type AppBindings = {
  Bindings: Env;
  Variables: { identity: AccessIdentity };
};
