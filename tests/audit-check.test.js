import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkAudit, AUDIT_EXCEPTIONS } from '../scripts/audit-check.js';

const FIRST = 'GHSA-vcc3-ghjq-m6fr', SECOND = 'GHSA-qr28-fpjm-wq7f', OTHER = 'GHSA-2222-3333-4444';
function advisory(id, severity = 'high', name = 'decode-uri-component') {
  return { name, severity, url: `https://github.com/advisories/${id}` };
}
function report(via, severity = 'high') {
  return { auditReportVersion: 2, vulnerabilities: {
    'decode-uri-component': { severity, via },
    'query-string': { severity, via: ['decode-uri-component'] },
    minio: { severity, via: ['query-string', 'moderate-package'] },
    'moderate-package': { severity: 'moderate', via: [advisory(OTHER, 'moderate', 'moderate-package')] },
  } };
}

test('only the two approved advisory IDs pass through their inclusive UTC expiry', () => {
  for (const id of [FIRST,SECOND]) {
    assert.equal(checkAudit(report([advisory(id)]),new Date('2026-10-31T00:00:00Z')).passed,true);
    assert.equal(checkAudit(report([advisory(id)]),new Date('2026-11-14T23:59:59.999Z')).passed,true);
    assert.equal(checkAudit(report([advisory(id)]),new Date('2026-11-15T00:00:00Z')).passed,false);
  }
  assert.equal(checkAudit(report([advisory(SECOND)]),new Date('2026-11-15T00:30:00+08:00')).passed,true);
  assert.equal(checkAudit(report([advisory(SECOND)]),new Date('2026-11-14T23:30:00-02:00')).passed,false);
  for (const exception of AUDIT_EXCEPTIONS) {
    assert.equal(exception.expires,'2026-11-14');
    assert.ok(exception.reason.includes('stringify'));
    assert.equal(exception.issue,'https://github.com/gridgoph/gridgo-api/issues/330');
  }
});

test('a new high/critical advisory on the same or another package still fails', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  for (const severity of ['high','critical']) {
    assert.equal(checkAudit(report([advisory(FIRST),advisory(SECOND),advisory(OTHER,severity)]),now).passed,false);
    const audit = report([advisory(SECOND)]);
    audit.vulnerabilities.another = { severity, via: [advisory(OTHER,severity,'another')] };
    assert.equal(checkAudit(audit,now).passed,false);
  }
  const audit = report([advisory(SECOND)]);
  audit.vulnerabilities.minio.via.push(advisory(OTHER,'high','minio'));
  assert.equal(checkAudit(audit,now).passed,false,'direct SDK advisory cannot hide behind its exempt dependency');
});

test('moderate/low advisories remain non-blocking, including after expiry', () => {
  for (const severity of ['moderate','low','info']) {
    assert.equal(checkAudit(report([advisory(OTHER,severity)],severity),new Date('2026-11-15T00:00:00Z')).passed,true);
  }
  assert.equal(checkAudit({auditReportVersion:2,vulnerabilities:{}},new Date('2026-11-15')).passed,true);
});

test('missing IDs, malformed reports and unresolved or cyclic dependency links fail closed', () => {
  const now = new Date('2026-11-01');
  assert.equal(checkAudit(report([{name:'decode-uri-component',severity:'high'}]),now).passed,false);
  assert.equal(checkAudit(report([advisory(`${SECOND}?ignored`)]),now).passed,false);
  for (const value of [null,{}, {error:{code:'REGISTRY_UNAVAILABLE'}}, {auditReportVersion:2,vulnerabilities:[]}]) {
    assert.throws(() => checkAudit(value,now),/audit report/i);
  }
  const audit = report([advisory(SECOND)]);
  audit.vulnerabilities.minio.via.push('missing');
  assert.throws(() => checkAudit(audit,now),/missing/i);
  const cycle = report([advisory(SECOND)]);
  cycle.vulnerabilities['query-string'].via = ['minio'];
  assert.throws(() => checkAudit(cycle,now),/cyclic/i);
  assert.throws(() => checkAudit(report([advisory(OTHER,'moderate')]),now),/unexplained high/i);
});

test('CLI runs the production-only audit and applies the high/critical policy to its JSON', async t => {
  const directory = await mkdtemp(path.join(tmpdir(),'gridgo-audit-check-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const argsFile = path.join(directory,'args.json');
  await writeFile(path.join(directory,'npm'),`#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.AUDIT_ARGS,JSON.stringify(process.argv.slice(2)));
process.stdout.write(process.env.AUDIT_PAYLOAD);
process.exit(Number(process.env.AUDIT_EXIT));
`,{mode:0o755});
  const run = (payload,status=1) => spawnSync(process.execPath,['scripts/audit-check.js'], {
    encoding:'utf8',env:{...process.env,PATH:`${directory}${path.delimiter}${process.env.PATH}`,
      AUDIT_ARGS:argsFile,AUDIT_PAYLOAD:typeof payload === 'string' ? payload : JSON.stringify(payload),AUDIT_EXIT:String(status)},
  });
  const moderate = run(report([advisory(OTHER,'moderate')],'moderate'));
  assert.equal(moderate.status,0,moderate.stderr);
  assert.deepEqual(JSON.parse(await readFile(argsFile,'utf8')),['audit','--omit=dev','--json']);
  assert.equal(run(report([advisory(OTHER)])).status,1);
  assert.equal(run('invalid JSON').status,1);
  assert.equal(run({error:{code:'REGISTRY_UNAVAILABLE'}},2).status,1);
});
