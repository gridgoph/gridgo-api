const defaults={payoutTime:'16:00',minimumMinor:10000,payDeadline:'18:00',reminderTime:'17:00',bonusRateBps:2000,bonusDays:7,bonusCapMinor:50000,
  businessWeekdays:[1,2,3,4,5],holidays:[],extraBusinessDates:[],launchedAt:null};
export const shopMoneySettings=settings=>({...defaults,...settings?.shopMoney});
const fail=()=>{throw Object.assign(new Error('invalid_shop_money_settings'),{status:400,code:'invalid_shop_money_settings'});};
export function validateShopMoneySettings(settings) {
  const raw=settings?.shopMoney,p=shopMoneySettings(settings);
  if(raw!==undefined&&(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!Object.hasOwn(defaults,k))))fail();
  for(const k of ['minimumMinor','bonusRateBps','bonusDays','bonusCapMinor'])if(!Number.isSafeInteger(p[k])||p[k]<0)fail();
  if(p.bonusRateBps>10000||p.bonusDays>365||p.minimumMinor<1)fail();
  for(const k of ['payoutTime','payDeadline','reminderTime'])if(typeof p[k]!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(p[k]))fail();
  if(p.payoutTime>=p.reminderTime||p.reminderTime>=p.payDeadline)fail();
  if(!Array.isArray(p.businessWeekdays)||!p.businessWeekdays.length||p.businessWeekdays.some(d=>!Number.isInteger(d)||d<0||d>6))fail();
  for(const k of ['holidays','extraBusinessDates'])if(!Array.isArray(p[k])||p[k].length>1000||p[k].some(d=>typeof d!=='string'||!/^\d{4}-\d\d-\d\d$/.test(d)||!Number.isFinite(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d))fail();
  if(p.launchedAt!==null&&(typeof p.launchedAt!=='string'||!Number.isFinite(Date.parse(p.launchedAt))))fail();
  return p;
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
  for(let n=0;n<3700;n++) {
    const date=new Date(Date.parse(clock.date)+n*86400000).toISOString().slice(0,10);
    if((n||clock.time<p.payoutTime)&&businessDate(date,p))return new Date(`${date}T${p.payoutTime}:00+08:00`).toISOString();
  }
  return null;
}
