import { Hono } from 'hono';
import {
  captureArtifacts,
  captureRequestSchema,
  encryptJson,
  type CaptureArtifact,
  type CaptureJob,
  type RequestOrigin,
} from '@design-manager/shared';
import { requireRole } from '../middleware/rbac';
import type { AppBindings } from '../env';

export const capturesRoutes = new Hono<AppBindings>();

capturesRoutes.post('/', requireRole('operator'), async (c) => {
  const body = captureRequestSchema.parse(await c.req.json());
  const identity = c.get('identity');

  const jobId = crypto.randomUUID();
  const envelope = await encryptJson(c.env.AUTH_ENC_KEY, body.auth);

  const requestedBy: RequestOrigin = identity.isServiceToken
    ? identity.clientId?.startsWith('saas:')
      ? { kind: 'saas', productId: identity.clientId.slice('saas:'.length) }
      : { kind: 'service-token', clientId: identity.clientId ?? 'unknown' }
    : { kind: 'dashboard', email: identity.email ?? 'unknown' };

  const job: CaptureJob = {
    jobId,
    productId: body.productId,
    userId: body.userId,
    url: body.url,
    viewport: body.viewport,
    settle: body.settle,
    encryptedAuth: envelope.ciphertext,
    authIv: envelope.iv,
    requestedBy,
    createdAt: Date.now(),
  };

  await c.env.DB
    .prepare(
      `INSERT INTO jobs
         (id, product_id, user_id, url, viewport_width, viewport_height,
          status, requested_by_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7, ?8, ?8)`,
    )
    .bind(
      jobId,
      body.productId,
      body.userId,
      body.url,
      body.viewport?.width ?? null,
      body.viewport?.height ?? null,
      JSON.stringify(requestedBy),
      job.createdAt,
    )
    .run();

  await c.env.CAPTURE_JOBS.send(job);

  await c.env.DB
    .prepare(
      `INSERT INTO audit_log (timestamp, actor_email, actor_product, action, target_type, target_id, metadata_json)
       VALUES (?1, ?2, ?3, 'capture.create', 'job', ?4, ?5)`,
    )
    .bind(
      job.createdAt,
      identity.email ?? null,
      requestedBy.kind === 'saas'
        ? requestedBy.productId
        : identity.isServiceToken
          ? identity.clientId ?? null
          : null,
      jobId,
      JSON.stringify({ productId: body.productId, url: body.url }),
    )
    .run();

  return c.json({ jobId, status: 'queued' }, 202);
});

capturesRoutes.get('/', requireRole('viewer'), async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT id, product_id, user_id, url, status, created_at, updated_at, completed_at
         FROM jobs
         ORDER BY created_at DESC
         LIMIT 100`,
    )
    .all();
  return c.json({ jobs: results });
});

capturesRoutes.get('/:id', requireRole('viewer'), async (c) => {
  const row = await c.env.DB
    .prepare(
      `SELECT id, product_id, user_id, url, status, requested_by_json,
              r2_prefix, error, created_at, updated_at, completed_at
         FROM jobs WHERE id = ?1`,
    )
    .bind(c.req.param('id'))
    .first();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ job: row });
});

// Streams a single R2 artifact for a completed job.
// The URL-segment `:artifact` is one of the keys of `captureArtifacts`
// (screenshot, mhtml, singleFile, rendered, meta, readme).
capturesRoutes.get('/:id/artifact/:artifact', requireRole('viewer'), async (c) => {
  const artifact = c.req.param('artifact') as CaptureArtifact;
  if (!(artifact in captureArtifacts)) {
    return c.json({ error: 'unknown artifact' }, 400);
  }

  const job = await c.env.DB
    .prepare('SELECT r2_prefix FROM jobs WHERE id = ?1')
    .bind(c.req.param('id'))
    .first<{ r2_prefix: string | null }>();
  if (!job?.r2_prefix) return c.json({ error: 'not found' }, 404);

  const key = `${job.r2_prefix}/${captureArtifacts[artifact]}`;
  const obj = await c.env.CAPTURES.get(key);
  if (!obj) return c.json({ error: 'artifact missing in R2' }, 404);

  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
    },
  });
});
