// Test-process preload only. Keep parsing, address policy, pinning, redirect
// handling and body limits real; substitute the external DNS/transport boundary.
import dns from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';
import assert from 'node:assert/strict';

const realLookup = dns.lookup;
dns.lookup = async (hostname, options) => {
  if (['canva.link', 'www.canva.com'].includes(hostname)) return [{ address: '93.184.216.34', family: 4 }];
  return realLookup(hostname, options);
};
https.request = (url, options, callback) => {
  assert.ok(['canva.link', 'www.canva.com'].includes(url.hostname), 'unexpected outbound HTTPS request');
  options.lookup(url.hostname, {}, (error, address, family) => {
    assert.ifError(error);
    assert.equal(address, '93.184.216.34');
    assert.equal(family, 4);
  });
  return http.request({ ...options, hostname: '127.0.0.1', port: Number(process.env.ARTWORK_TEST_PORT), path: url.pathname + url.search, headers: { ...options.headers, Host: url.host } }, callback);
};
