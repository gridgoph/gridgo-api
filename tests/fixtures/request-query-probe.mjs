// Loaded only into a test child with NODE_OPTIONS --import. Associate pg
// statements with an explicitly marked HTTP request, excluding lifecycle work.
import http from 'node:http';
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

const requests = new AsyncLocalStorage();
const createServer = http.createServer;
http.createServer = function (...args) {
  const listenerIndex = args.findIndex(arg => typeof arg === 'function');
  if (listenerIndex >= 0) {
    const listener = args[listenerIndex];
    args[listenerIndex] = function (req, res) {
      const id = req.headers['x-gridgo-test-query-id'];
      if (!id) return listener.call(this, req, res);
      const trace = { id, statements: [] };
      res.once('finish', () => process.stdout.write(`GRIDGO_TEST_QUERY_TRACE ${JSON.stringify(trace)}\n`));
      return requests.run(trace, () => listener.call(this, req, res));
    };
  }
  return createServer.apply(this, args);
};
const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (statement, ...args) {
  const trace = requests.getStore();
  if (trace) trace.statements.push(typeof statement === 'string' ? statement : statement.text);
  return query.call(this, statement, ...args);
};
