/** Weeks start Monday 00:00 in Manila. No inferred actors or acceptance times. */
export function teamStats(store, shopId, role, at) {
  const local = new Date(Date.parse(at) + 480 * 60000);
  local.setUTCHours(0, 0, 0, 0);
  local.setUTCDate(local.getUTCDate() - (local.getUTCDay() + 6) % 7);
  const start = local.getTime() - 480 * 60000, end = start + 7 * 86400000;
  const members = [
    ...(store.shopMemberships || []).filter(m => m.shopId === shopId && m.status === 'active').map(m => ({userId:m.userId,name:store.users.find(u=>u.id===m.userId)?.name || 'Member'})),
    ...(store.shopPinStaff || []).filter(m => m.shopId === shopId && m.status === 'active').map(m => ({pinStaffId:m.id,name:m.name})),
  ];
  const ownOrders = new Set((store.orders || []).filter(o => o.supplierId === shopId).map(o => o.id));
  const actions = (store.orderActions || []).filter(a => Date.parse(a.at) >= start && Date.parse(a.at) < end && Date.parse(a.at) <= Date.parse(at)
    && (a.shopId ? a.shopId === shopId : ownOrders.has(a.orderId) && ['owner','staff','manager'].includes(a.actorRole)));
  const key = row => row.pinStaffId || row.userId;
  const metrics = members.map(member => {
    const own = actions.filter(a => (a.actorPinStaffId || a.actorUserId) === key(member));
    const accepted = new Map();
    for (const a of own) if (a.action === 'order.accepted' && Number.isSafeInteger(a.acceptanceMilliseconds) && a.acceptanceMilliseconds >= 0 && !accepted.has(a.orderId)) accepted.set(a.orderId,a.acceptanceMilliseconds);
    return {...member,jobsThisWeek:new Set(own.map(a=>a.orderId)).size,acceptedJobs:accepted.size,
      averageAcceptSeconds:accepted.size ? Math.round([...accepted.values()].reduce((a,b)=>a+b,0)/accepted.size/1000) : null};
  });
  const candidates = metrics.filter(m=>m.acceptedJobs).sort((a,b)=>a.averageAcceptSeconds-b.averageAcceptSeconds || key(a).localeCompare(key(b)));
  const winner = candidates[0];
  const fastest = winner ? {...(winner.pinStaffId ? {pinStaffId:winner.pinStaffId} : {userId:winner.userId}),name:winner.name,badge:'fastest_this_week'} : null;
  const acceptances = new Map();
  for (const a of actions) if (a.action === 'order.accepted' && Number.isSafeInteger(a.acceptanceMilliseconds) && a.acceptanceMilliseconds>=0 && !acceptances.has(a.orderId)) acceptances.set(a.orderId,a.acceptanceMilliseconds);
  const quick = [...acceptances.values()].filter(ms=>ms>=0 && ms<=300000).length;
  const hide = role === 'staff' && (store.shopTeamSettings || []).find(s=>s.shopId===shopId)?.showRankingToStaff === false;
  return {weekStartsAt:new Date(start).toISOString(),weekEndsAt:new Date(end).toISOString(),fastestThisWeek:hide?null:fastest,
    mission:{code:'accept_within_five_minutes',targetJobs:10,acceptedJobs:acceptances.size,quickAcceptedJobs:quick,completed:quick>=10},
    ...(['owner','manager'].includes(role)?{members:metrics}:{})};
}
