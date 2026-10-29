// Test-only alternate reader and clock; the production entrypoint has no switch.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const NativeDate = Date, at = Number(process.env.GRIDGO_TEST_BOOTSTRAP_TIME);
assert.ok(Number.isFinite(at));
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [at])); }
  static now() { return at; }
};
if (process.env.GRIDGO_TEST_BOOTSTRAP_FULL === '1') registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    if (!url.endsWith('/src/server.js')) return result;
    let source = String(result.source);
    for (const [before, after] of [
      ["const hotRead = req.method === 'GET' && isHotReadPath(pathname);", 'const hotRead = false;'],
      ['await loadClientBootstrapStore(database, clientId)', 'await load()'],
      ['if (!testerBootstrapNeedsWrite(latest, clientId, ctx)) return latest;', ''],
    ]) {
      assert.ok(source.includes(before), `full-reader fixture no longer matches: ${before}`);
      source = source.replace(before, after);
    }
    return { ...result, source };
  },
});
