import type { CaptureRequest, CaptureStatus } from '@design-manager/shared';
import { captureArtifacts, type CaptureArtifact } from '@design-manager/shared';

export interface JobSummary {
  id: string;
  product_id: string;
  user_id: string;
  url: string;
  status: CaptureStatus;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface JobDetail extends JobSummary {
  requested_by_json: string;
  r2_prefix: string | null;
  error: string | null;
}

async function parseError(res: Response): Promise<string> {
  try {
    const json = (await res.clone().json()) as { error?: string };
    if (json.error) return json.error;
  } catch {
    // not json — fall through
  }
  return (await res.text().catch(() => '')) || `${res.status} ${res.statusText}`;
}

export async function listJobs(): Promise<JobSummary[]> {
  const res = await fetch('/v1/captures');
  if (!res.ok) throw new Error(`listJobs: ${await parseError(res)}`);
  const body = (await res.json()) as { jobs: JobSummary[] };
  return body.jobs;
}

export async function getJob(id: string): Promise<JobDetail> {
  const res = await fetch(`/v1/captures/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`getJob: ${await parseError(res)}`);
  const body = (await res.json()) as { job: JobDetail };
  return body.job;
}

export async function triggerCapture(req: CaptureRequest): Promise<{ jobId: string }> {
  const res = await fetch('/v1/captures', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`triggerCapture: ${await parseError(res)}`);
  return (await res.json()) as { jobId: string };
}

export function artifactUrl(jobId: string, artifact: CaptureArtifact): string {
  return `/v1/captures/${encodeURIComponent(jobId)}/artifact/${artifact}`;
}

export const ARTIFACT_LABELS: Record<CaptureArtifact, string> = {
  screenshot: `${captureArtifacts.screenshot} — PNG`,
  singleFile: `${captureArtifacts.singleFile} — self-contained HTML`,
  mhtml: `${captureArtifacts.mhtml} — MHTML archive`,
  rendered: `${captureArtifacts.rendered} — raw HTML + <base>`,
  meta: `${captureArtifacts.meta} — metadata`,
  readme: `${captureArtifacts.readme} — README`,
};
