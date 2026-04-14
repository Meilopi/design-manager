export type CaptureStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface Viewport {
  width: number;
  height: number;
}

export interface SettleConfig {
  waitUntil: 'networkidle0' | 'networkidle2' | 'load' | 'domcontentloaded';
  selector?: string;
  mutationQuietMs?: number;
  maxWaitMs?: number;
}

export type AuthKind = 'impersonation' | 'session';

export interface AuthPayload {
  kind: AuthKind;
  /** For 'impersonation': a short-TTL JWT.  For 'session': a raw session blob (cookie/header). */
  value: string;
}

export interface CaptureRequest {
  productId: string;
  userId: string;
  url: string;
  viewport?: Viewport;
  settle?: Partial<SettleConfig>;
  auth: AuthPayload;
}

/**
 * Shape placed on the `capture-jobs` queue and passed as Workflow params.
 * Auth material is encrypted; no plaintext credentials leave the API Worker.
 */
export interface CaptureJob {
  jobId: string;
  productId: string;
  userId: string;
  url: string;
  viewport?: Viewport;
  settle?: Partial<SettleConfig>;
  /** AES-GCM ciphertext of AuthPayload, base64url. */
  encryptedAuth: string;
  /** AES-GCM IV, base64url. */
  authIv: string;
  /** Grant id for the fallback D1 `auth_grants` path, when the ciphertext isn't inlined. */
  authGrantId?: string;
  requestedBy: RequestOrigin;
  createdAt: number;
}

export type RequestOrigin =
  | { kind: 'dashboard'; email: string }
  | { kind: 'service-token'; clientId: string }
  | { kind: 'saas'; productId: string; email?: string };

export interface AclRow {
  email: string;
  role: 'viewer' | 'operator' | 'admin';
}
