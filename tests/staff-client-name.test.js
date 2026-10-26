import test from 'node:test';
import assert from 'node:assert/strict';
import { publicOrderFor } from '../src/operational-model.js';
import { actors, fixture } from './fixtures/reschedule.js';

test('operations and super admin receive the client name, and nobody else does', () => {
  const store = fixture();
  const client = store.users.find((user) => user.id === 'client');
  client.name = 'Mina Cruz';
  const order = store.orders[0];

  assert.equal(publicOrderFor(order, actors.ops, store).clientName, 'Mina Cruz');
  assert.equal(publicOrderFor(order, actors.admin, store).clientName, 'Mina Cruz');
  for (const actor of [actors.client, actors.supplier, actors.rider]) {
    assert.equal(Object.hasOwn(publicOrderFor(order, actor, store), 'clientName'), false);
  }

  order.clientName = 'Stored on the order';
  assert.equal(publicOrderFor(order, actors.client, store).clientName, 'Stored on the order');
  assert.equal(Object.hasOwn(publicOrderFor(order, actors.supplier, store), 'clientName'), false);
  assert.equal(Object.hasOwn(publicOrderFor(order, actors.rider, store), 'clientName'), false);
  assert.equal(publicOrderFor(order, actors.ops, store).clientName, 'Mina Cruz');

  client.name = '   ';
  assert.equal(publicOrderFor(order, actors.ops, store).clientName, null);
  store.users = store.users.filter((user) => user.id !== 'client');
  assert.equal(publicOrderFor(order, actors.admin, store).clientName, null);
  assert.equal(Object.hasOwn(publicOrderFor(order, actors.supplier, store), 'clientName'), false);
});
