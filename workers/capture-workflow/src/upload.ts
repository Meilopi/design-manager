import { captureKey, type CaptureArtifact, type CaptureJob } from '@design-manager/shared';
import type { CaptureArtifacts } from './capture';

const CONTENT_TYPES: Record<CaptureArtifact, string> = {
  screenshot: 'image/png',
  mhtml: 'multipart/related',
  singleFile: 'text/html; charset=utf-8',
  rendered: 'text/html; charset=utf-8',
  meta: 'application/json',
  readme: 'text/markdown; charset=utf-8',
};

/** Upload every artifact to R2 under `captures/<product>/<YYYY-MM-DD>/<jobId>/`. */
export async function uploadArtifacts(
  bucket: R2Bucket,
  job: CaptureJob,
  artifacts: CaptureArtifacts,
  at: number,
): Promise<Record<CaptureArtifact, string>> {
  const when = new Date(at);
  const k = (artifact: CaptureArtifact): string => captureKey(job.productId, job.jobId, artifact, when);

  await Promise.all([
    bucket.put(k('screenshot'), artifacts.screenshot, {
      httpMetadata: { contentType: CONTENT_TYPES.screenshot },
    }),
    bucket.put(k('mhtml'), artifacts.mhtml, {
      httpMetadata: { contentType: CONTENT_TYPES.mhtml },
    }),
    bucket.put(k('singleFile'), artifacts.singleFile, {
      httpMetadata: { contentType: CONTENT_TYPES.singleFile },
    }),
    bucket.put(k('rendered'), artifacts.rendered, {
      httpMetadata: { contentType: CONTENT_TYPES.rendered },
    }),
    bucket.put(k('meta'), JSON.stringify(artifacts.meta, null, 2), {
      httpMetadata: { contentType: CONTENT_TYPES.meta },
    }),
    bucket.put(k('readme'), artifacts.readme, {
      httpMetadata: { contentType: CONTENT_TYPES.readme },
    }),
  ]);

  return {
    screenshot: k('screenshot'),
    mhtml: k('mhtml'),
    singleFile: k('singleFile'),
    rendered: k('rendered'),
    meta: k('meta'),
    readme: k('readme'),
  };
}
