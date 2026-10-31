// Test-only dispatcher bypass and clock; production has no baseline switch.
export function readParityEnv(full, at) {
  const hook = `
    import { registerHooks } from 'node:module';
    const NativeDate = Date;
    globalThis.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [${at}])); }
      static now() { return ${at}; }
    };
    ${full ? `registerHooks({ load(url, context, next) {
      const result = next(url, context);
      if (url.endsWith('/src/postgres-store.js')) {
        const source = String(result.source).replace(/export function isHotReadPath\\(pathname\\) \\{[^}]+\\}/,
          'export function isHotReadPath() { return false; }');
        if (source === String(result.source)) throw new Error('Full-store baseline was not installed');
        return { ...result, source };
      }
      return result;
    } });` : ''}`;
  return { NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(hook)}`, MINIO_PUBLIC_URL: 'https://storage.example.invalid' };
}

