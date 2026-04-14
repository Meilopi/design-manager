#!/usr/bin/env node
// Fails CI if any wrangler config file is missing `workers_dev: false`.
// Matches the Zero-Trust guarantee in docs/ARCHITECTURE.md.

import { readFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === '.wrangler' || entry === 'dist') continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/^wrangler\.(jsonc?|toml)$/i.test(entry)) files.push(p);
  }
}
walk(root);

let bad = 0;
for (const file of files) {
  const raw = await readFile(file, 'utf8');
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const match = stripped.match(/["']?workers_dev["']?\s*[:=]\s*(true|false)/);
  if (!match) {
    console.error(`[workers_dev-check] MISSING in ${file} — expected workers_dev: false`);
    bad++;
  } else if (match[1] !== 'false') {
    console.error(`[workers_dev-check] FORBIDDEN "${match[0]}" in ${file}`);
    bad++;
  }
}
if (bad > 0) {
  console.error(`\n${bad} wrangler config(s) failed the workers.dev check.`);
  process.exit(1);
}
console.log(`[workers_dev-check] OK — ${files.length} wrangler config(s), all workers_dev: false`);
