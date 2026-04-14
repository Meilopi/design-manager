/** Deterministic R2 key builders — aligned with the layout documented in ARCHITECTURE.md §6. */

export function captureDir(productId: string, jobId: string, at: Date = new Date()): string {
  const yyyy = at.getUTCFullYear();
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(at.getUTCDate()).padStart(2, '0');
  return `captures/${productId}/${yyyy}-${mm}-${dd}/${jobId}`;
}

export const captureArtifacts = {
  screenshot: 'screenshot.png',
  mhtml: 'snapshot.mhtml',
  singleFile: 'single-file.html',
  rendered: 'rendered.html',
  meta: 'meta.json',
  readme: 'README.md',
} as const;

export type CaptureArtifact = keyof typeof captureArtifacts;

export function captureKey(
  productId: string,
  jobId: string,
  artifact: CaptureArtifact,
  at?: Date,
): string {
  return `${captureDir(productId, jobId, at)}/${captureArtifacts[artifact]}`;
}
