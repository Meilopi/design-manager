import type { Page } from '@cloudflare/puppeteer';

/**
 * Capture the page as MHTML via CDP `Page.captureSnapshot`.
 *
 * Returns the full multipart/related archive as a string — suitable for direct
 * R2 upload. MHTML embeds every network resource the renderer actually fetched,
 * so it is the highest-fidelity of the three HTML deliverables.
 */
export async function captureMhtml(page: Page): Promise<string> {
  const client = await page.createCDPSession();
  const result = (await client.send('Page.captureSnapshot', { format: 'mhtml' })) as { data: string };
  return result.data;
}
