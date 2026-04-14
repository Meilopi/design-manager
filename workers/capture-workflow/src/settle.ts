import type { Page } from '@cloudflare/puppeteer';
import type { SettleConfig } from '@design-manager/shared';

/**
 * Composite SPA settle heuristic applied AFTER `page.goto` has resolved its
 * `waitUntil` condition.  Combines:
 *   - document.readyState === 'complete'
 *   - optional selector wait
 *   - bounded MutationObserver quiet window
 */
export async function runSettle(page: Page, cfg: SettleConfig): Promise<void> {
  const max = cfg.maxWaitMs ?? 15_000;

  await page.waitForFunction(() => document.readyState === 'complete', { timeout: max });

  if (cfg.selector) {
    await page.waitForSelector(cfg.selector, { timeout: max });
  }

  if (cfg.mutationQuietMs && cfg.mutationQuietMs > 0) {
    await waitForMutationQuiet(page, cfg.mutationQuietMs, max);
  }
}

async function waitForMutationQuiet(page: Page, quietMs: number, maxMs: number): Promise<void> {
  await page.evaluate(
    async (quiet: number, max: number) => {
      await new Promise<void>((resolve) => {
        let lastMutation = performance.now();
        const observer = new MutationObserver(() => {
          lastMutation = performance.now();
        });
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        const start = performance.now();
        const timer = setInterval(() => {
          const now = performance.now();
          if (now - lastMutation >= quiet || now - start >= max) {
            clearInterval(timer);
            observer.disconnect();
            resolve();
          }
        }, 100);
      });
    },
    quietMs,
    maxMs,
  );
}
