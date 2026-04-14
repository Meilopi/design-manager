import type { CaptureJob } from '@design-manager/shared';

interface Env {
  DB: D1Database;
  CAPTURE_WORKFLOW: Workflow<CaptureJob>;
}

/**
 * Dispatcher: pull jobs off `capture-jobs` and create a Workflow instance per
 * URL, using the jobId as the instance id so duplicate sends are deduped at
 * the Workflow layer.
 */
export default {
  async queue(batch: MessageBatch<CaptureJob>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const job = msg.body;
      try {
        await env.CAPTURE_WORKFLOW.create({ id: job.jobId, params: job });
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
