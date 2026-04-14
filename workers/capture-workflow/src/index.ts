import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  captureDir,
  decryptJson,
  type AuthPayload,
  type CaptureJob,
  type SettleConfig,
} from '@design-manager/shared';
import type { Env } from './env';
import { runCapture } from './capture';
import { uploadArtifacts } from './upload';

interface ProductRow {
  id: string;
  auth_strategy: 'impersonation' | 'session';
  magic_link_endpoint: string | null;
  default_settle_json: string | null;
}

export class CaptureWorkflow extends WorkflowEntrypoint<Env, CaptureJob> {
  override async run(event: WorkflowEvent<CaptureJob>, step: WorkflowStep): Promise<void> {
    const job = event.payload;
    const startedAt = Date.now();

    const product = await step.do('resolve-product', async () => {
      const row = await this.env.DB
        .prepare(
          `SELECT id, auth_strategy, magic_link_endpoint, default_settle_json
             FROM products WHERE id = ?1`,
        )
        .bind(job.productId)
        .first<ProductRow>();
      if (!row) throw new Error(`unknown product: ${job.productId}`);
      return row;
    });

    const settle: Partial<SettleConfig> = {
      ...(product.default_settle_json ? (JSON.parse(product.default_settle_json) as Partial<SettleConfig>) : {}),
      ...(job.settle ?? {}),
    };

    // Capture + upload live in ONE step so the plaintext auth payload never
    // gets persisted as a step return value (which Workflows durably records).
    // Retrying the whole step re-uses the same R2 keys, so it is idempotent.
    const upload = await step.do(
      'capture-and-upload',
      {
        retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
        timeout: '4 minutes',
      },
      async () => {
        const auth = await decryptJson<AuthPayload>(this.env.AUTH_ENC_KEY, {
          ciphertext: job.encryptedAuth,
          iv: job.authIv,
        });

        await this.env.DB
          .prepare(
            `INSERT INTO audit_log
               (timestamp, actor_email, actor_product, action, target_type, target_id, metadata_json)
             VALUES (?1, ?2, ?3, 'auth.decrypt', 'job', ?4, NULL)`,
          )
          .bind(
            Date.now(),
            job.requestedBy.kind === 'dashboard' ? job.requestedBy.email : null,
            job.requestedBy.kind === 'service-token' ? job.requestedBy.clientId : null,
            job.jobId,
          )
          .run();

        const artifacts = await runCapture(this.env.BROWSER, job, auth, settle);
        const keys = await uploadArtifacts(this.env.CAPTURES, job, artifacts, startedAt);
        return {
          prefix: captureDir(job.productId, job.jobId, new Date(startedAt)),
          keys,
          durationMs: artifacts.meta.durationMs,
        };
      },
    );

    await step.do('mark-complete', async () => {
      const now = Date.now();
      await this.env.DB
        .prepare(
          `UPDATE jobs
             SET status = 'completed',
                 r2_prefix = ?2,
                 completed_at = ?3,
                 updated_at = ?3
             WHERE id = ?1`,
        )
        .bind(job.jobId, upload.prefix, now)
        .run();
    });
  }
}

// Workflow-only worker: a stub fetch handler so the script still loads cleanly.
export default {
  async fetch(): Promise<Response> {
    return new Response('capture-workflow — invoke via the Workflow binding', { status: 404 });
  },
};
