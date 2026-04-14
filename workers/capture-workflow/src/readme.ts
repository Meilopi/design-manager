import type { CaptureMeta } from './capture';

/** Renders the per-capture README.md uploaded alongside every capture in R2. */
export function buildReadme(meta: CaptureMeta): string {
  return [
    `# Capture ${meta.jobId}`,
    '',
    `- **Product**: ${meta.productId}`,
    `- **User**:    ${meta.userId}`,
    `- **URL**:     ${meta.url}`,
    `- **Viewport**: ${meta.viewport.width}×${meta.viewport.height}`,
    `- **Captured at**: ${new Date(meta.capturedAt).toISOString()}`,
    `- **Duration**: ${meta.durationMs} ms`,
    '',
    '## Which file should I use?',
    '',
    '| File | When to use it |',
    '|---|---|',
    '| `screenshot.png` | Default for QA review and any tool that only wants the image. |',
    '| `single-file.html` | **Default for Design.** Opens in any browser, no network required; every asset (CSS, images, fonts) is inlined as a data URI. Editable in VS Code. |',
    '| `snapshot.mhtml` | Full-fidelity archive. Opens in Chromium-based browsers. Use when `single-file.html` is missing an asset (typically a CORS-blocked cross-origin image). |',
    '| `rendered.html` | Raw outerHTML with an injected `<base href>`. For debugging / re-fetching assets live. |',
    '| `meta.json` | Capture metadata (settle strategy, viewport, timings). |',
    '',
    '## Opening `snapshot.mhtml`',
    '',
    '- Chrome / Edge: open directly (double-click).',
    '- Safari / Firefox: not natively supported — prefer `single-file.html`.',
    '',
    '## Settle strategy applied',
    '',
    '```json',
    JSON.stringify(meta.settle, null, 2),
    '```',
    '',
  ].join('\n');
}
