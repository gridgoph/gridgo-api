import { spawn } from 'node:child_process';
// The test files share one isolated PostgreSQL database and must remain serial.
// Accept Jest-style worker caps used by the fleet, never exceed the given cap.
const args = process.argv.slice(2);
const cap = args.find(value => value.startsWith('--maxWorkers='));
if (cap && (!/^--maxWorkers=[1-9]\d*$/.test(cap))) throw new Error('maxWorkers must be a positive integer');
const files = args.filter(value => value !== cap);
const testFiles = files.length ? files : (await import('node:fs/promises')).readdir('tests').then(names => names.filter(name => name.endsWith('.test.js')).sort().map(name => `tests/${name}`));
const child = spawn(process.execPath,['--test','--test-concurrency=1',...await testFiles],{stdio:'inherit',env:process.env});
child.on('exit',(code,signal)=>{if(signal) process.kill(process.pid,signal); else process.exitCode=code ?? 1;});
