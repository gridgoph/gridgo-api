import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

test('the backfill npm entry point is included in the production image', () => {
  const root = new URL('../', import.meta.url);
  const { scripts } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  const entry = scripts['backfill:last-sign-ins'].trim().split(/\s+/).at(-1);
  const dockerfile = readFileSync(new URL('Dockerfile', root), 'utf8');
  const runner = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
  const copies = [...runner.matchAll(/^COPY(?:\s+--\S+)*\s+(\S+)\s+(\S+)\s*$/gm)];
  const included = copies.some(([, source, destination]) => {
    const directory = path.posix.normalize(destination).replace(/\/$/, '');
    if (!entry.startsWith(`${directory}/`)) return false;
    const relative = entry.slice(directory.length + 1);
    return existsSync(new URL(`${source}/${relative}`, root));
  });
  assert.ok(included, `${entry} must be copied into the production image`);
});
