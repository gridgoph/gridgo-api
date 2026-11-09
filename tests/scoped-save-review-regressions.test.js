import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/database.js';
import { loadStore, saveStore, loadClientSaveStore, loadClientSavePreflightStore } from '../src/postgres-store.js';
import { defaultShopSchedule } from '../src/availability.js';
import { syncSupplierPerformance } from '../src/supplier-performance.js';
import { saveUpkeepNeeded } from '../src/save-upkeep.js';
import { setupSaveParity, saveParityApi, saveRows, SAVE_AT } from './fixtures/save-parity.js';
const skip=!process.env.DATABASE_URL;
const at=new Date(SAVE_AT).toISOString();

test('earlier pending foreign incidents preserve the own performance consequence and audit before and after sweep', {skip}, async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());
  const ownRows=async()=>({
    event:(await db.query("SELECT * FROM supplier_performance_events WHERE order_id='own_late' AND source_key='finish'")).rows[0],
    audit:(await db.query("SELECT * FROM audit_log WHERE order_id='own_late' AND action='supplier_performance.late_finish'")).rows[0],
  });
  const run=async full=>{
    await setupSaveParity(db);
    await db.transaction(async()=>{
      const store=await loadStore(db),base=store.orders.find(row=>row.id==='order');
      for(let i=1;i<=2;i++) store.orders.push({...structuredClone(base),id:`other_late_${i}`,clientId:'other'});
      store.orders.push({...structuredClone(base),id:'own_late'});
      store.orderLineItems.push({...structuredClone(store.orderLineItems[0]),id:'own_late_line',orderId:'own_late',jobId:null,
        turnaroundDaysSnapshot:2,productionDayMinutesSnapshot:600,turnaroundMinutesSnapshot:1200,turnaroundHoursSnapshot:20});
      await saveStore(db,store);
    });
    await db.query("UPDATE orders SET ready_at=$1 WHERE id LIKE 'other_late_%'",[new Date(SAVE_AT-3600000).toISOString()]);
    await db.query("UPDATE orders SET ready_at=$1 WHERE id='own_late'",[new Date(SAVE_AT-1000).toISOString()]);
    const api=await saveParityApi(t,full);
    const response=await api('client','POST','/me/matches',{subcategoryCode:'flyers'},{raw:true});
    assert.equal(response.status,200,response.body);
    const before=await ownRows();
    await db.transaction(async()=>{
      const store=await loadStore(db);let sequence=0;
      syncSupplierPerformance(store,{at,id:prefix=>`${prefix}_review_sweep_${++sequence}`});
      await saveStore(db,store);
    });
    assert.deepEqual(await ownRows(),before,'a later sweep cannot repair an immutable own consequence');
    return {response:{status:response.status,body:response.body},before};
  };
  const full=await run(true),scoped=await run(false);
  assert.equal(full.before.event.data.topPickHiddenUntil,'2026-11-16T03:59:59.000Z');
  assert.equal(full.before.event.data.rosterReviewTriggered,true);
  assert.deepEqual(scoped,full);
});

test('a foreign cancellation on a previously assigned shop remains threshold context after its reassignment', {skip}, async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());
  const run=async full=>{
    await setupSaveParity(db);
    await db.transaction(async()=>{
      const store=await loadStore(db),base=store.orders.find(row=>row.id==='order');
      store.orders.push({...structuredClone(base),id:'foreign_moved',clientId:'other',supplierId:'dual',
        shopFailureEvents:[{id:'prior_shop',supplierId:'supplier',kind:'cancelled',stage:'production',reason:'Fixture accepted cancellation',at:new Date(SAVE_AT-3600000).toISOString()}]});
      base.shopFailureEvents=[{id:'own_cancel',supplierId:'supplier',kind:'cancelled',stage:'production',reason:'Fixture accepted cancellation',at:new Date(SAVE_AT-1000).toISOString()}];
      await saveStore(db,store);
    });
    const api=await saveParityApi(t,full),response=await api('client','POST','/me/matches',{subcategoryCode:'flyers'},{raw:true});
    assert.equal(response.status,200,response.body);
    const event=(await db.query("SELECT * FROM supplier_performance_events WHERE order_id='order' AND source_key='failure:own_cancel'")).rows[0];
    const audit=(await db.query("SELECT * FROM audit_log WHERE order_id='order' AND action='supplier_performance.cancelled'")).rows[0];
    return {status:response.status,body:response.body,event,audit};
  };
  const full=await run(true),scoped=await run(false);
  assert.equal(full.event.data.rosterReviewTriggered,true);
  assert.deepEqual(scoped,full);
});

test('shop-hours then matching persists the full decoder service/catalogue/job normalization', {skip}, async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());
  const run=async full=>{
    await setupSaveParity(db);
    await db.transaction(async()=>{
      const store=await loadStore(db);
      Object.assign(store.supplierServices.find(row=>row.id==='service_supplier'),{
        turnaroundDays:1,turnaroundMinutes:600,turnaroundHours:10,
        standardTurnaroundDays:1,standardTurnaroundMinutes:600,standardTurnaroundHours:10});
      const item=store.catalogItems.find(row=>row.id==='item_supplier');
      Object.assign(item,{turnaroundMode:'override',turnaroundDays:1,turnaroundMinutes:600,turnaroundHours:10});
      if(item.approvedSnapshot) Object.assign(item.approvedSnapshot.item,{turnaroundDays:1,turnaroundMinutes:600,turnaroundHours:10});
      await saveStore(db,store);
    });
    const api=await saveParityApi(t,full),schedule=defaultShopSchedule();
    for(const shift of schedule.week) shift.closesMinute=shift.opensMinute+480;
    const hours=await api('supplier','PATCH','/me/shop-hours',{expectedVersion:1,schedule},{raw:true});
    assert.equal(hours.status,200,hours.body);
    assert.equal((await db.query('SELECT dirty FROM store_production_normalization')).rows[0].dirty,true,'a source schedule change cannot clear its own stale compatibility view');
    await db.query("UPDATE order_jobs SET estimated_production_minutes=120,estimated_hours=3 WHERE id='job'");
    const response=await api('client','POST','/me/matches',{subcategoryCode:'flyers'},{raw:true});
    assert.equal(response.status,200,response.body);
    assert.equal((await db.query('SELECT dirty FROM store_production_normalization')).rows[0].dirty,false);
    const production={};
    for(const table of ['supplier_services','supplier_catalog_items','supplier_catalog_speed_tiers','listing_starters'])
      production[table]=(await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)).rows;
    return {hours:{status:hours.status,body:hours.body},response:{status:response.status,body:response.body},production,rows:await saveRows(db)};
  };
  const full=await run(true),scoped=await run(false);
  const service=full.production.supplier_services.find(row=>row.row.id==='service_supplier').row;
  assert.equal(service.standard_turnaround_minutes,480);assert.equal(service.standard_turnaround_hours,8);
  assert.equal(full.rows.order_jobs.find(row=>row.id==='job').estimated_hours,2);
  assert.deepEqual(scoped,full);
});

test('normalization outside the request graph is a bounded upkeep candidate and reaches the full result', {skip}, async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());
  const seed=async()=>{
    await setupSaveParity(db);
    await db.query("UPDATE order_jobs SET estimated_production_minutes=120,estimated_hours=3 WHERE id='job_dual_order'");
  };
  await seed();
  const preflight=await loadClientSavePreflightStore(db,'clerk_client','/me/matches',{subcategoryCode:'flyers'});
  assert.ok(!preflight.orderJobs.some(row=>row.id==='job_dual_order'));
  assert.equal(await saveUpkeepNeeded(db,at),true);
  const full=await saveParityApi(t,true);
  assert.equal((await full('client','POST','/me/matches',{subcategoryCode:'flyers'})).status,200);
  const expected=await saveRows(db);delete expected.client_match_selections;
  await seed();
  await saveParityApi(t,false,{upkeep:true});
  const deadline=Date.now()+10000;
  while((await db.query("SELECT estimated_hours FROM order_jobs WHERE id='job_dual_order'")).rows[0].estimated_hours!==2 && Date.now()<deadline)
    await new Promise(resolve=>setTimeout(resolve,25));
  const actual=await saveRows(db);delete actual.client_match_selections;
  assert.deepEqual(actual,expected);
  assert.equal(await saveUpkeepNeeded(db,at),false);
});

test('normalization marker invalidates on all source statements and rolls back atomically', {skip}, async t=>{
  const db=createDatabase(process.env);
  const {up}=await import('../migrations/1794186800000_production_normalization_pending.js');
  const sources=['supplier_profiles','supplier_services','supplier_catalog_items','supplier_catalog_speed_tiers',
    'listing_starters','order_line_items','order_jobs'];
  const schema=`save_normalization_${process.pid}`;
  t.after(async()=>{try{await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{await db.close();}});
  await db.transaction(async()=>{
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET LOCAL search_path TO ${schema}`);
    for(const name of sources) await db.query(`CREATE TABLE ${name}(id integer PRIMARY KEY)`);
    let sql;await up({sql:value=>{sql=value;}});await db.query(sql);
    const dirty=async()=>(await db.query('SELECT dirty FROM store_production_normalization')).rows[0].dirty;
    assert.equal(await dirty(),true,'forward migration queues pre-existing normalization');
    for(const name of sources) for(const action of [
      `INSERT INTO ${name} VALUES(1)`,`UPDATE ${name} SET id=2`,`DELETE FROM ${name}`,`TRUNCATE ${name}`,
    ]) {
      await db.query('UPDATE store_production_normalization SET dirty=false');
      await db.query(action);assert.equal(await dirty(),true,action);
    }
    await db.query('UPDATE store_production_normalization SET dirty=false');
    await db.query('SAVEPOINT before_source_write');
    await db.query('INSERT INTO order_jobs VALUES(1)');assert.equal(await dirty(),true);
    await db.query('ROLLBACK TO SAVEPOINT before_source_write');assert.equal(await dirty(),false);
  });
});

test('a partial writer cannot clear foreign normalization and a stale clean marker cannot erase decoder changes', {skip}, async t=>{
  const db=createDatabase(process.env);t.after(()=>db.close());
  await setupSaveParity(db);
  const before=(await db.query("SELECT * FROM order_jobs WHERE id='job_dual_order'")).rows[0];
  await assert.rejects(db.transaction(async()=>{
    const graph=await loadClientSaveStore(db,'clerk_client','/me/matches',{subcategoryCode:'flyers'});
    assert.ok(graph);
    await db.query("UPDATE order_jobs SET estimated_production_minutes=120,estimated_hours=3 WHERE id='job_dual_order'");
    await saveStore(db,graph);
    assert.equal((await db.query('SELECT dirty FROM store_production_normalization')).rows[0].dirty,true);
    throw new Error('rollback partial normalization');
  }),/rollback partial normalization/);
  assert.deepEqual((await db.query("SELECT * FROM order_jobs WHERE id='job_dual_order'")).rows[0],before);
  assert.equal((await db.query('SELECT dirty FROM store_production_normalization')).rows[0].dirty,false);
  let staleFull;
  await db.transaction(async()=>{staleFull=await loadStore(db);});
  await assert.rejects(db.transaction(async()=>{
    await db.query("UPDATE order_jobs SET estimated_production_minutes=120,estimated_hours=3 WHERE id='job_dual_order'");
    await saveStore(db,staleFull);
    assert.equal((await db.query('SELECT dirty FROM store_production_normalization')).rows[0].dirty,true,
      'a complete graph from a previous transaction cannot clear newer source invalidation');
    throw new Error('rollback stale normalization');
  }),/rollback stale normalization/);
  await db.query("UPDATE order_jobs SET estimated_production_minutes=120,estimated_hours=3 WHERE id='job'");
  await db.query('UPDATE store_production_normalization SET dirty=false');
  await db.transaction(async()=>{
    assert.equal(await loadClientSaveStore(db,'clerk_client','/me/matches',{subcategoryCode:'flyers'}),null,
      'the pre-synchronization delta requires exact legacy persistence even with stale cache metadata');
  });
});
