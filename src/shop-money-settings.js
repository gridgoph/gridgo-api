const defaults={payoutTime:'16:00',minimumMinor:10000,payDeadline:'18:00',reminderTime:'17:00',bonusRateBps:2000,bonusDays:7,bonusCapMinor:50000,
  businessWeekdays:[1,2,3,4,5],holidays:[],extraBusinessDates:[],launchedAt:null,
  weeklyNettingEnabled:false,overduePauseEnabled:false,weeklyDueWeekday:1,weeklyDueTime:'23:59',
  reviewMinutes:3,reviewOpens:'08:00',reviewCloses:'17:00',missedJobLimit:3,acceptanceSeconds:60,
  demandAlertsPerDay:2,demandRadiusMeters:5000,openMinutes:[30,60]};
export const shopMoneySettings=(settings,env=process.env)=>{
  const enabled=['development','test'].includes(env.NODE_ENV);
  return {...defaults,weeklyNettingEnabled:enabled,overduePauseEnabled:enabled,...settings?.shopMoney};
};
const fail=()=>{throw Object.assign(new Error('invalid_shop_money_settings'),{status:400,code:'invalid_shop_money_settings'});};
export function validateShopMoneySettings(settings) {
  const raw=settings?.shopMoney,p=shopMoneySettings(settings);
  if(raw!==undefined&&(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!Object.hasOwn(defaults,k))))fail();
  for(const k of ['minimumMinor','bonusRateBps','bonusDays','bonusCapMinor'])if(!Number.isSafeInteger(p[k])||p[k]<0)fail();
  if(p.bonusRateBps>10000||p.bonusDays>365||p.minimumMinor<1)fail();
  for(const k of ['weeklyNettingEnabled','overduePauseEnabled'])if(typeof p[k]!=='boolean')fail();
  if(!Number.isInteger(p.weeklyDueWeekday)||p.weeklyDueWeekday<0||p.weeklyDueWeekday>6)fail();
  for(const [k,max] of [['reviewMinutes',60],['missedJobLimit',100],['acceptanceSeconds',3600],['demandAlertsPerDay',100],['demandRadiusMeters',100000]])
    if(!Number.isSafeInteger(p[k])||p[k]<1||p[k]>max)fail();
  for(const k of ['weeklyDueTime','reviewOpens','reviewCloses'])if(typeof p[k]!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(p[k]))fail();
  if(p.reviewOpens>=p.reviewCloses||!Array.isArray(p.openMinutes)||!p.openMinutes.length||p.openMinutes.length>10||p.openMinutes.some(n=>!Number.isInteger(n)||n<1||n>1440))fail();
  for(const k of ['payoutTime','payDeadline','reminderTime'])if(typeof p[k]!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(p[k]))fail();
  if(p.payoutTime>=p.reminderTime||p.reminderTime>=p.payDeadline)fail();
  if(!Array.isArray(p.businessWeekdays)||!p.businessWeekdays.length||p.businessWeekdays.some(d=>!Number.isInteger(d)||d<0||d>6))fail();
  for(const k of ['holidays','extraBusinessDates'])if(!Array.isArray(p[k])||p[k].length>1000||p[k].some(d=>typeof d!=='string'||!/^\d{4}-\d\d-\d\d$/.test(d)||!Number.isFinite(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d))fail();
  if(p.launchedAt!==null&&(typeof p.launchedAt!=='string'||!Number.isFinite(Date.parse(p.launchedAt))))fail();
  return p;
}
/** The most recent completed Monday-Sunday period, independent of server zone. */
export function weeklyShopPeriod(settings,at) {
  const p=shopMoneySettings(settings),c=manilaClock(at);
  const monday=Date.parse(c.date)-((c.weekday+6)%7)*86400000;
  const start=new Date(monday-7*86400000).toISOString().slice(0,10),end=new Date(monday).toISOString().slice(0,10);
  const dueDate=new Date(monday+((p.weeklyDueWeekday+6)%7)*86400000).toISOString().slice(0,10);
  return {start,end,runAt:new Date(`${end}T${p.payoutTime}:00+08:00`).toISOString(),
    deadlineAt:new Date(Date.parse(`${dueDate}T${p.weeklyDueTime}:00+08:00`)+59999).toISOString()};
}
export function shopReceiptReviewBy(settings,at) {
  const p=shopMoneySettings(settings),c=manilaClock(at);
  const opens=Date.parse(`${c.date}T${p.reviewOpens}:00+08:00`),closes=Date.parse(`${c.date}T${p.reviewCloses}:00+08:00`);
  let cursor=Date.parse(at),remaining=p.reviewMinutes*60000;
  if(cursor<opens)cursor=opens;
  if(cursor>=closes)cursor=opens+86400000;
  let end=cursor>=closes?closes+86400000:closes;
  while(cursor+remaining>end){remaining-=end-cursor;cursor=end+86400000-(closes-opens);end+=86400000;}
  return new Date(cursor+remaining).toISOString();
}
export function manilaClock(at) {
  const local=new Date(Date.parse(at)+8*3600000).toISOString();
  return {date:local.slice(0,10),time:local.slice(11,16),weekday:new Date(local).getUTCDay()};
}
export function businessDate(date,p) {
  return p.extraBusinessDates.includes(date)||(!p.holidays.includes(date)&&p.businessWeekdays.includes(new Date(date).getUTCDay()));
}
export function nextShopPayout(settings,at) {
  const p=shopMoneySettings(settings),clock=manilaClock(at);
  if(p.weeklyNettingEnabled) {
    const period=weeklyShopPeriod(settings,at);
    return Date.parse(at)<Date.parse(period.runAt)?period.runAt:new Date(Date.parse(period.runAt)+7*86400000).toISOString();
  }
  for(let n=0;n<3700;n++) {
    const date=new Date(Date.parse(clock.date)+n*86400000).toISOString().slice(0,10);
    if((n||clock.time<p.payoutTime)&&businessDate(date,p))return new Date(`${date}T${p.payoutTime}:00+08:00`).toISOString();
  }
  return null;
}
