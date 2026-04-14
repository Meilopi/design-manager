import {
  captureRequestSchema,
  type AuthPayload,
  type CaptureRequest,
  type SettleConfig,
  type Viewport,
} from '@design-manager/shared';
import { signHs256Jwt } from './jwt';

export type Transport =
  | { kind: 'binding'; service: Fetcher; internalServiceToken: string }
  | { kind: 'http'; url: string; serviceToken: { clientId: string; clientSecret: string } };

export interface CaptureClientConfig {
  productId: string;
  transport: Transport;
  /**
   * Required to auto-mint impersonation JWTs on `capture()` calls that omit
   * an explicit `auth`. The signing key here must match the product's
   * `signing_public_key` row in the capture system's D1.
   */
  impersonation?: {
    signingKey: string;         // base64url HMAC-SHA256 key
    ttlSeconds?: number;        // default 60
    audience?: string;          // default 'capture'
  };
}

export interface CaptureInput {
  userId: string;
  url: string;
  viewport?: Viewport;
  settle?: Partial<SettleConfig>;
  /** Explicit auth payload — if omitted, an impersonation JWT is auto-minted. */
  auth?: AuthPayload;
  /** Scope claim embedded in the auto-minted JWT. Default 'capture:read'. */
  scope?: string;
}

export interface CaptureResponse {
  jobId: string;
  status: 'queued';
}

export interface CaptureClient {
  capture(input: CaptureInput): Promise<CaptureResponse>;
  mintImpersonationJwt(userId: string, scope?: string): Promise<string>;
}

const DEFAULT_TTL = 60;
const DEFAULT_AUDIENCE = 'capture';
const DEFAULT_SCOPE = 'capture:read';
const MAX_ATTEMPTS = 3;
const BINDING_ORIGIN = 'https://capture-api.internal';

export function createCaptureClient(cfg: CaptureClientConfig): CaptureClient {
  async function mint(userId: string, scope: string): Promise<string> {
    if (!cfg.impersonation) {
      throw new Error('createCaptureClient: `impersonation` config required to auto-mint a JWT');
    }
    const now = Math.floor(Date.now() / 1000);
    const ttl = cfg.impersonation.ttlSeconds ?? DEFAULT_TTL;
    return signHs256Jwt(cfg.impersonation.signingKey, {
      sub: userId,
      aud: cfg.impersonation.audience ?? DEFAULT_AUDIENCE,
      productId: cfg.productId,
      scope,
      iat: now,
      exp: now + ttl,
    });
  }

  async function post(body: CaptureRequest): Promise<CaptureResponse> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.transport.kind === 'binding') {
      headers['X-Internal-Service-Token'] = cfg.transport.internalServiceToken;
      headers['X-Internal-Source-Product'] = cfg.productId;
    } else {
      headers['CF-Access-Client-Id'] = cfg.transport.serviceToken.clientId;
      headers['CF-Access-Client-Secret'] = cfg.transport.serviceToken.clientSecret;
    }

    const url =
      cfg.transport.kind === 'binding'
        ? `${BINDING_ORIGIN}/v1/captures`
        : `${cfg.transport.url.replace(/\/$/, '')}/v1/captures`;

    const init: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    };

    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res =
          cfg.transport.kind === 'binding'
            ? await cfg.transport.service.fetch(url, init)
            : await fetch(url, init);

        if (res.ok) return (await res.json()) as CaptureResponse;

        // Don't retry client errors.
        if (res.status < 500) {
          const text = await res.text().catch(() => '');
          throw new Error(`capture api ${res.status}: ${text}`);
        }
        lastErr = new Error(`capture api ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      if (attempt < MAX_ATTEMPTS) {
        const base = 200 * 2 ** (attempt - 1);
        const jitter = Math.floor(Math.random() * base);
        await sleep(base + jitter);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('capture api: unknown error');
  }

  return {
    async mintImpersonationJwt(userId, scope = DEFAULT_SCOPE) {
      return mint(userId, scope);
    },
    async capture(input) {
      const auth: AuthPayload =
        input.auth ?? {
          kind: 'impersonation',
          value: await mint(input.userId, input.scope ?? DEFAULT_SCOPE),
        };
      const body = captureRequestSchema.parse({
        productId: cfg.productId,
        userId: input.userId,
        url: input.url,
        viewport: input.viewport,
        settle: input.settle,
        auth,
      }) as CaptureRequest;
      return post(body);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
