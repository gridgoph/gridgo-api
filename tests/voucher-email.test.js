import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoucherEmailWorker } from '../src/voucher-email.js';

test('voucher SMTP delivery retries failures and runs outside its claim transaction', async () => {
  for (const fails of [true, false]) {
    let inTransaction = false, claims = 0;
    const updates = [], mails = [];
    const database = {
      async transaction(fn) { inTransaction = true; try { return await fn(); } finally { inTransaction = false; } },
      async query(sql, values) {
        assert.equal(inTransaction, true);
        if (sql.includes('RETURNING *')) {
          assert.match(sql, /v.email_allowed=true/);
          return { rows: claims++ ? [] : [{ id: 'mail', email: 'adult@example.test', subject: 'Your voucher', body: 'Expires soon', attempts: 1 }] };
        }
        updates.push(values); return { rows: [] };
      },
    };
    const work = createVoucherEmailWorker({ database, env: { EMAIL_USER: 'sender@example.test', EMAIL_PASSWORD: 'test' },
      createTransport: () => ({ async sendMail(mail) { assert.equal(inTransaction, false); mails.push(mail); if (fails) throw new Error('offline'); return { accepted: [mail.to], rejected: [] }; } }) });
    await work();
    assert.equal(mails.length, 1); assert.equal(updates[0][1], fails ? 'pending' : 'sent');
  }
});
test('unconfigured email never queries or blocks voucher issuance', async () => {
  const work = createVoucherEmailWorker({ database: { query() { assert.fail('unexpected database access'); } }, env: {} });
  await work();
});
