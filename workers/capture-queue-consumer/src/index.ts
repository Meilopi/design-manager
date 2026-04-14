import type { CaptureJob } from '@design-manager/shared';

interface Env {
  DB: D1Database;
  // Phase 2: CAPTURE_WORKFLOW: Workflow;
}

/**
 * Phase 1 skeleton: consume `capture-jobs`, mark the job running in D1, and log
 * the intent. Phase 2 replaces the console.log with:
 *     await env.CAPTURE_WORKFLOW.create({ id: job.jobId, params: job });
 */
export default {
  async queue(batch: MessageBatch<CaptureJob>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const job = msg.body;
      try {
        console.log(
          `[capture-queue-consumer] would launch workflow for job ${job.jobId} ` +
            `(product=${job.productId} url=${job.url})`,
        );

        await env.DB
          .prepare(`UPDATE jobs SET status = 'running', updated_at = ?2 WHERE id = ?1`)
          .bind(job.jobId, Date.now())
          .run();

        msg.ack();
      } catch (err) {
        console.error(`[capture-queue-consumer] dispatch failed for ${job.jobId}`, err);
        msg.retry();
      }
    }
  },
};
