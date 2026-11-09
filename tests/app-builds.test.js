import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGridgoApp } from '../src/app-builds.js';

test('app headers parse a safe integer build independently of their display version', () => {
  for (const app of ['client', 'supplier', 'rider']) {
    assert.deepEqual(parseGridgoApp(` ${app}/1.0.260+161 `), { app, version: '1.0.260', build: 161 });
  }
  assert.deepEqual(parseGridgoApp('rider/1.0.0+0'), { app: 'rider', version: '1.0.0', build: 0 });
  assert.deepEqual(parseGridgoApp('rider/1.0.0+9007199254740991'), { app: 'rider', version: '1.0.0', build: 9007199254740991 });
});

test('legacy, unknown and malformed app headers have no parsed build', () => {
  for (const value of [undefined, null, [], ['rider/1.0.0+1'], {}, 161, '', 'rider', 'dashboard', 'unknown/1.0.0+1',
    'Rider/1.0.0+1', 'rider/1.0+1', 'rider/v1.0.0+1', 'rider/1.0.0', 'rider/1.0.0+-1', 'rider/1.0.0+1.5',
    'rider/1.0.0+9007199254740992', 'rider/1.0.0+Infinity', 'rider/1.0.0+1 trailing',
    'rider/1.0.0+1, rider/1.0.0+2']) assert.equal(parseGridgoApp(value), null, String(value));
});
