import type { Page } from '@cloudflare/puppeteer';

/**
 * Build a single self-contained HTML file: every `<link rel="stylesheet">`,
 * `<img>`, `<link rel="icon">` and CSS `url(...)` reference is fetched via
 * in-page `fetch` and inlined as a data URI (or a `<style>` block for CSS).
 *
 * Cross-origin assets that fail CORS are left as absolute URLs — the MHTML
 * sibling captures them in full, so a degraded single-file.html still renders
 * layout correctly against those original URLs.
 *
 * Scripts are removed: the DOM is already rendered, re-executing JS against an
 * offline origin typically breaks the page.
 */
export async function buildSingleFile(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    async function toDataUri(url: string, mime?: string): Promise<string | null> {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return null;
        const blob = await res.blob();
        const ct = mime ?? blob.type ?? 'application/octet-stream';
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < buf.length; i += CHUNK) {
          bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
        }
        return `data:${ct};base64,${btoa(bin)}`;
      } catch {
        return null;
      }
    }

    async function inlineCssUrls(css: string, baseUrl: string): Promise<string> {
      const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
      const matches = [...css.matchAll(urlRe)];
      const replacements = new Map<string, string>();
      await Promise.all(
        matches.map(async (m) => {
          const ref = m[2];
          if (!ref || ref.startsWith('data:') || ref.startsWith('#')) return;
          let abs: string;
          try {
            abs = new URL(ref, baseUrl).toString();
          } catch {
            return;
          }
          if (replacements.has(abs)) return;
          const uri = await toDataUri(abs);
          if (uri) replacements.set(abs, uri);
        }),
      );
      return css.replace(urlRe, (full, _q, ref: string) => {
        if (!ref || ref.startsWith('data:') || ref.startsWith('#')) return full;
        try {
          const abs = new URL(ref, baseUrl).toString();
          const hit = replacements.get(abs);
          return hit ? `url("${hit}")` : full;
        } catch {
          return full;
        }
      });
    }

    // 1) Inline <link rel="stylesheet">
    const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'));
    for (const link of links) {
      const href = link.href;
      const res = await fetch(href, { credentials: 'include' }).catch(() => null);
      if (!res || !res.ok) continue;
      const css = await res.text();
      const inlined = await inlineCssUrls(css, href);
      const style = document.createElement('style');
      style.setAttribute('data-from', href);
      style.textContent = inlined;
      link.replaceWith(style);
    }

    // 2) Inline url(...) refs inside existing <style> blocks (e.g. @font-face).
    const styles = Array.from(document.querySelectorAll('style'));
    for (const style of styles) {
      if (!style.textContent) continue;
      style.textContent = await inlineCssUrls(style.textContent, document.baseURI);
    }

    // 3) Inline <img src> (strip srcset — easier than rewriting every candidate).
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('img[src]'));
    await Promise.all(
      imgs.map(async (img) => {
        const uri = await toDataUri(img.src);
        if (uri) img.setAttribute('src', uri);
        img.removeAttribute('srcset');
      }),
    );

    // 4) Inline favicons.
    const icons = Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"][href], link[rel="shortcut icon"][href]'),
    );
    await Promise.all(
      icons.map(async (link) => {
        const uri = await toDataUri(link.href);
        if (uri) link.href = uri;
      }),
    );

    // 5) Drop <script> tags — we serve a rendered snapshot, not a live app.
    document.querySelectorAll('script').forEach((s) => s.remove());

    return '<!doctype html>\n' + document.documentElement.outerHTML;
  });
}
