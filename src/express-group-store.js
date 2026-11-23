const maps=[['express_groups','expressGroups',{id:'id',host_id:'hostId',state:'state',token_hash:'tokenHash',closes_at:'closesAt',created_at:'createdAt',updated_at:'updatedAt',total_minor:'totalMinor',delivery_fee_minor:'deliveryFeeMinor'}],
  ['express_group_members','expressGroupMembers',{group_id:'groupId',user_id:'userId',active:'active',joined_at:'joinedAt',print_subtotal_minor:'printSubtotalMinor',delivery_share_minor:'deliveryShareMinor',amount_owed_minor:'amountOwedMinor'}]];
export const groupTables=maps.map(([name,,map])=>({name,keys:name==='express_groups'?['id']:['group_id','user_id'],columns:[...Object.keys(map),'data']}));
export function groupRows(store,rows) {
  for(const [table,collection,map] of maps)rows[table]=(store[collection]||[]).map(item=>{
    const amount=table==='express_group_members'?(store.expressGroups||[]).find(g=>g.id===item.groupId)?.amounts?.find(a=>a.userId===item.userId):null;
    const record={...item,...amount};
    return {...Object.fromEntries(Object.entries(map).map(([sql,js])=>{
      const value=js.endsWith('Minor')?record[js]??0:record[js];
      if(js.endsWith('Minor')&&!Number.isSafeInteger(value))throw new RangeError('Group amount must be safe integer centavos');
      return [sql,value];
    })),data:Object.fromEntries(Object.entries(record).filter(([key])=>key!=='amounts'&&!Object.values(map).includes(key)))};
  });
}
export function loadGroupRows(store,rows) {
  for(const [table,collection,map] of maps)store[collection]=(rows[table]||[]).map(row=>({...row.data,...Object.fromEntries(Object.entries(map).map(([sql,js])=>[js,row[sql]]))}));
  for(const group of store.expressGroups)group.amounts=store.expressGroupMembers.filter(m=>m.groupId===group.id&&m.active).map(m=>({userId:m.userId,fileCount:m.fileCount??m.files?.length??0,pageCount:m.pageCount??0,printSubtotalMinor:m.printSubtotalMinor,deliveryShareMinor:m.deliveryShareMinor,amountOwedMinor:m.amountOwedMinor}));
}
