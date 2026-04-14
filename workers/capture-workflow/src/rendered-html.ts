import type { Page } from '@cloudflare/puppeteer';

/**
 * Raw `document` outerHTML with a `<base href>` injected into `<head>` so any
 * relative URL resolves against the original origin. The secondary / fallback
 * deliverable — single-file.html is the one Design should use by default.
 */
export async function buildRenderedHtml(page: Page, url: string): Promise<string> {
  const html = await page.content();
  const baseTag = `<base href="${escapeAttr(url)}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>\n  ${baseTag}`);
  }
  return `<!doctype html><html><head>${baseTag}</head><body>${html}</body></html>`;
}

function escapeAttr(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}
