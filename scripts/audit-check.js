import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const AUDIT_EXCEPTIONS = [
  {
    id: 'GHSA-vcc3-ghjq-m6fr', package: 'decode-uri-component', expires: '2026-11-14',
    reason: 'Installed MinIO uses query-string.stringify only, never its decoder; source trace in https://github.com/gridgoph/gridgo-api/pull/329.',
    issue: 'https://github.com/gridgoph/gridgo-api/issues/330',
  },
  {
    id: 'GHSA-qr28-fpjm-wq7f', package: 'decode-uri-component', expires: '2026-11-14',
    reason: 'Installed MinIO uses query-string.stringify only, never its decoder; source trace in https://github.com/gridgoph/gridgo-api/pull/329.',
    issue: 'https://github.com/gridgoph/gridgo-api/issues/330',
  },
];

const SEVERITIES = new Set(['info', 'low', 'moderate', 'high', 'critical']);

/** Resolve npm's transitive package summaries to their individual advisories.
 * A package is never exempted wholesale: any additional high/critical ID fails.
 */
export function checkAudit(report, now = new Date()) {
  if (report?.error || report?.auditReportVersion !== 2 || !report.vulnerabilities
      || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)) {
    throw new Error('Invalid npm audit report');
  }
  const today = now.toISOString().slice(0, 10), advisories = new Map(), resolved = new Map();
  const collect = (name, ancestors = new Set()) => {
    if (!Object.hasOwn(report.vulnerabilities, name)) throw new Error(`Missing audit report dependency: ${name}`);
    if (ancestors.has(name)) throw new Error(`Cyclic audit report dependency: ${name}`);
    if (resolved.has(name)) return resolved.get(name);
    const row = report.vulnerabilities[name];
    if (!SEVERITIES.has(row?.severity) || !Array.isArray(row.via) || !row.via.length) throw new Error(`Invalid audit report entry: ${name}`);
    const path = new Set([...ancestors, name]);
    let hasHigh = false;
    for (const via of row.via) {
      if (typeof via === 'string') hasHigh = collect(via, path) || hasHigh;
      else {
        if (!via || !SEVERITIES.has(via.severity)) throw new Error(`Invalid audit report advisory: ${name}`);
        if (['high', 'critical'].includes(via.severity)) hasHigh = true;
        const url = typeof via.url === 'string' ? via.url : '';
        const id = /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/.exec(url)?.[1] || null;
        advisories.set(`${name}:${url}:${via.severity}`, { package: name, id, url, severity: via.severity });
      }
    }
    if (['high', 'critical'].includes(row.severity) && !hasHigh) throw new Error(`Unexplained high/critical audit report entry: ${name}`);
    resolved.set(name, hasHigh);
    return hasHigh;
  };
  for (const name of Object.keys(report.vulnerabilities)) collect(name);
  const blocked = [], excepted = [];
  for (const advisory of advisories.values()) {
    if (!['high', 'critical'].includes(advisory.severity)) continue;
    const exception = AUDIT_EXCEPTIONS.find(row => row.id === advisory.id && row.package === advisory.package && today <= row.expires);
    if (exception) excepted.push({ ...advisory, expires: exception.expires, issue: exception.issue });
    else blocked.push(advisory);
  }
  return { passed: blocked.length === 0, blocked, excepted };
}

function main() {
  try {
    const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.signal || ![0, 1].includes(result.status)) throw new Error(`npm audit failed (exit ${result.status ?? 'unknown'})`);
    const audit = checkAudit(JSON.parse(result.stdout));
    for (const row of audit.excepted) console.log(`EXCEPTION ${row.id} through ${row.expires} UTC; ${row.issue}`);
    for (const row of audit.blocked) console.error(`BLOCK ${row.severity} ${row.package}: ${row.id || row.url || 'unidentified advisory'}`);
    console.log(`Production dependency audit: ${audit.blocked.length} high/critical blockers; ${audit.excepted.length} approved time-limited exceptions. Moderate/low findings remain non-blocking.`);
    process.exitCode = audit.passed ? 0 : 1;
  } catch (error) {
    console.error(`Audit check failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
