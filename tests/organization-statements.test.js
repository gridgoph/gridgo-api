import test from 'node:test';
import assert from 'node:assert/strict';
import { routeOrganizationStatements } from '../src/organization-statements.js';

function fixture() {
  return { users: [{ id: 'c', accountType: 'organization' }], userRoleMemberships: [{ userId: 'c', role: 'client' }],
    approvalCases: [{ userId: 'c', kind: 'business_client', status: 'approved' }],
    orders: [
      { id: 'a', basketId: 'b', clientId: 'c', state: 'completed', totalMinor: 10500, organizationDiscountMinor: 500,
        invoiceNumber: 'GG-1', timeline: [{ state: 'completed', at: '2026-10-01T00:00:00Z' }], officerOfRecord: { name: 'Officer Example' } },
      { id: 'b', basketId: 'b', clientId: 'c', state: 'payout_released', totalMinor: 21000, organizationDiscountMinor: 1000,
        invoiceNumber: 'GG-1', timeline: [{ state: 'completed', at: '2026-10-15T00:00:00Z' }, { state: 'payout_released', at: '2026-11-15T00:00:00Z' }] },
      { id: 'open', clientId: 'c', state: 'issue_window_open', totalMinor: 100000 },
      { id: 'other', clientId: 'other', state: 'completed', totalMinor: 100000, timeline: [{ state: 'completed', at: '2026-10-15T00:00:00Z' }] },
      { id: 'end', clientId: 'c', state: 'completed', totalMinor: 100000, timeline: [{ state: 'completed', at: '2026-10-31T16:00:00Z' }] },
    ], orderLineItems: [{ orderId: 'a', itemNameSnapshot: '=unsafe, "product"' }] };
}
const call = (store, query = '?from=2026-10-01&to=2026-10-31', user = { id: 'c', role: 'client' }, path = '/me/organization/statements') =>
  routeOrganizationStatements({ req: { method: 'GET' }, url: new URL(`http://test${path}${query}`), store, user, now: () => '2026-10-20T00:00:00Z' });
test('statements count closed groups once, sum immutable money and use closure date in Manila', () => {
  const statement = call(fixture()).body.statement;
  assert.equal(statement.totalSpendMinor, 31500);
  assert.equal(statement.discountEarnedMinor, 1500);
  assert.equal(statement.orderCount, 2);
  assert.equal(statement.orders[0].officerOfRecord, 'Officer Example');
  assert.equal(statement.orders[1].officerOfRecord, '');
  assert.match(statement.notice, /not a tax document/i);
  assert.equal(call(fixture(), '?period=this_month').body.statement.totalSpendMinor, 31500);
  assert.equal(call(fixture(), '?period=this_quarter').body.statement.orderCount, 3);
});
test('statement gate rejects unapproved accounts and cross-account access; staff selects a client', () => {
  const store = fixture();
  assert.throws(() => call(store, '', { id: 'other', role: 'client' }), { code: 'organization_approval_required' });
  assert.throws(() => call(store, '', { id: 'c', role: 'supplier' }), { code: 'forbidden' });
  store.approvalCases[0].status = 'pending';
  assert.throws(() => call(store), { code: 'organization_approval_required' });
  store.approvalCases[0].status = 'approved';
  assert.throws(() => call(store, '', { id: 'c', role: 'client' }, '/ops/organizations/c/statements'), { code: 'forbidden' });
  assert.equal(call(store, '?from=2026-10-01&to=2026-10-31', { id: 'ops', role: 'ops_admin' }, '/ops/organizations/c/statements').body.statement.orderCount, 2);
  assert.throws(() => call(store, '', null), { code: 'unauthorized' });
});
test('exports use the same totals and guard CSV formulas; malformed periods are refused', () => {
  const csv = call(fixture(), '?from=2026-10-01&to=2026-10-31&format=csv');
  assert.equal(csv.contentType, 'text/csv; charset=utf-8');
  assert.match(csv.bytes.toString(), /315.00/);
  assert.match(csv.bytes.toString(), /15.00/);
  assert.match(csv.bytes.toString(), /'=unsafe/);
  const pdf = call(fixture(), '?from=2026-10-01&to=2026-10-31&format=pdf');
  assert.equal(pdf.contentType, 'application/pdf');
  assert.match(pdf.bytes.toString('ascii', 0, 8), /^%PDF-1\./);
  for (const query of ['?from=2026-02-30&to=2026-10-01', '?from=2026-10-02&to=2026-10-01', '?period=nope', '?format=exe', '?from=2026-10-01']) {
    assert.throws(() => call(fixture(), query), (e) => e.status === 400);
  }
});

 test('statements retain order-time officers and stay available during a handover', () => {
  const store = fixture();
  store.approvalCases[0].status = 'pending';
  store.organizationAccounts = [{ userId: 'c', currentOfficer: { fullName: 'Current Officer' } }];
  store.orders[0].organizationOfficer = { fullName: 'Original Officer' };
  store.orderInvoices = [{ orderId: store.orders[1].id, snapshot: { organizationOfficer: { fullName: 'Invoice Officer' } } }];
  const statement = call(store).body.statement;
  assert.equal(statement.orders[0].officerOfRecord, 'Original Officer');
  assert.equal(statement.orders[1].officerOfRecord, 'Invoice Officer');
  const output = call(store, '?from=2026-10-01&to=2026-10-31&format=csv').bytes.toString();
  assert.match(output, /Original Officer/);
  assert.match(output, /Invoice Officer/);
  assert.doesNotMatch(output, /Current Officer/);
 });
