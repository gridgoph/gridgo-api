import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { up as shopTeams } from '../migrations/1794192200000_shop_teams.js';
import { up as inviteLifetime } from '../migrations/1795272000000_shop_selection_and_invite_lifetime.js';
import { up as legacyCompatibility } from '../migrations/1795272100000_shop_invite_legacy_upsert.js';
import { legacyInviteUpsert } from './fixtures/legacy-shop-invite.js';
import { inviteHash } from '../src/shop-team.js';

test('legacy invite upserts consume 24-hour invites and preserve 48-hour issuance and guards', {skip: !process.env.DATABASE_URL}, async t => {
  const db = createDatabase(process.env);
  t.after(() => db.close());
  await db.transaction(async () => {
    await db.query('CREATE SCHEMA shop_invite_compat_test');
    await db.query('SET LOCAL search_path TO shop_invite_compat_test');
    await db.query('SAVEPOINT compat_fixture');
    try {
      await db.query(`CREATE TABLE users(id text PRIMARY KEY,name text);
        CREATE TABLE user_role_memberships(user_id text,role text,created_at timestamptz);
        CREATE TABLE orders(id text PRIMARY KEY);
        CREATE TABLE audit_log(id text,order_id text,actor_id text,actor_role text,action text,at timestamptz,data jsonb);
        INSERT INTO users VALUES ('owner','Owner'),('client','Client'),('other','Other');`);
      await shopTeams({sql: sql => db.query(sql)});
      await inviteLifetime({sql: sql => db.query(sql)});
      const makeInvite = (id, hours) => ({id, shopId:'owner', kind:'link', tokenHash:inviteHash(id), createdBy:'owner',
        createdAt:'2026-11-22T00:00:00.000Z', expiresAt:new Date(Date.UTC(2026,10,22,hours)).toISOString()});
      const read = async id => (await db.query('SELECT * FROM shop_invites WHERE id=$1',[id])).rows[0];
      const rejectWrite = async (write, expected) => {
        await db.query('SAVEPOINT rejected_write');
        await assert.rejects(write, expected);
        await db.query('ROLLBACK TO SAVEPOINT rejected_write');
      };
      const issued = [];
      for (const hours of [24,48]) for (const action of ['claim','revoke','replace']) {
        const invite = makeInvite(`${action}_${hours}`,hours);
        await db.query(`INSERT INTO shop_invites(id,shop_id,kind,token_hash,created_by,created_at,expires_at,lifetime_hours)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[invite.id,invite.shopId,invite.kind,invite.tokenHash,invite.createdBy,invite.createdAt,invite.expiresAt,hours]);
        issued.push(invite);
      }
      const before = (await db.query('SELECT * FROM shop_invites ORDER BY id')).rows;
      // The compatibility migration must also repair databases that already issued invites.
      await legacyCompatibility({sql: sql => db.query(sql)});
      assert.deepEqual((await db.query('SELECT * FROM shop_invites ORDER BY id')).rows,before);
      for (const invite of issued) {
        const original = await read(invite.id);
        const claim = invite.id.startsWith('claim_');
        const consumed = {...invite,...(claim ? {claimedBy:'client',claimedAt:'2026-11-22T01:00:00.000Z'} : {revokedAt:'2026-11-22T01:00:00.000Z'})};
        await legacyInviteUpsert(db,consumed);
        assert.deepEqual(await read(invite.id),{...original,
          ...(claim ? {claimed_by:consumed.claimedBy,claimed_at:consumed.claimedAt} : {revoked_at:consumed.revokedAt})});
        // An unchanged save is allowed even after consumption, as with the old adapter.
        await legacyInviteUpsert(db,consumed);
        if (invite.id.startsWith('replace_')) {
          const replacement = makeInvite(`${invite.id}_replacement`,48);
          await legacyInviteUpsert(db,replacement);
          assert.equal((await read(replacement.id)).lifetime_hours,48);
          assert.equal((await read(invite.id)).revoked_at,consumed.revokedAt);
        }
        await rejectWrite(() => legacyInviteUpsert(db,invite),/immutable/);
        await rejectWrite(() => legacyInviteUpsert(db,{...consumed,createdAt:'2026-11-21T00:00:00.000Z',expiresAt:'2026-11-23T00:00:00.000Z'}),/immutable/);
        await rejectWrite(() => legacyInviteUpsert(db,{...consumed,claimedBy:'other',claimedAt:'2026-11-22T02:00:00.000Z'}),/immutable|check constraint/);
        for (const [column,value] of [['created_at','2026-11-21T00:00:00Z'],['expires_at','2026-11-25T00:00:00Z'],['lifetime_hours',original.lifetime_hours===24?48:24]]) {
          await rejectWrite(() => db.query(`UPDATE shop_invites SET ${column}=$1 WHERE id=$2`,[value,invite.id]),/immutable/);
        }
      }
      for (const hours of [0,25,49]) {
        await rejectWrite(() => legacyInviteUpsert(db,makeInvite(`invalid_${hours}`,hours)),{code:'23514',constraint:'shop_invites_lifetime_check'});
      }
      const both = {...makeInvite('both_consumed',24),claimedBy:'client',claimedAt:'2026-11-22T01:00:00.000Z',revokedAt:'2026-11-22T01:00:00.000Z'};
      await rejectWrite(() => legacyInviteUpsert(db,both),{code:'23514'});
      await rejectWrite(() => legacyInviteUpsert(db,{...makeInvite('missing_claimant',24),claimedAt:'2026-11-22T01:00:00.000Z'}),{code:'23514'});
    } catch (error) {
      await db.query('ROLLBACK TO SAVEPOINT compat_fixture');
      throw error;
    } finally {
      await db.query('SET LOCAL search_path TO public');
      await db.query('DROP SCHEMA shop_invite_compat_test CASCADE');
    }
  });
});
