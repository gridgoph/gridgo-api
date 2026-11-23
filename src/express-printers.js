import { expressFail, expressShopList } from './express-orders.js';

/** Filter/expand after capability and exact-file quotes, so closed or incapable
 * printers never satisfy the minimum three open choices. */
export function expressPrinterChoices(store,user,options,at,quotedRows=null) {
 const {location,fulfillmentMode='pickup',sort='nearby',shopsOnly=false,verifiedOnly=false}=options;
 if(!['nearby','nearest','all_davao','fastest','top_rated','lowest_price','fewest_jobs'].includes(sort))expressFail(400,'invalid_express_sort');
 for(const value of [shopsOnly,verifiedOnly])if(typeof value!=='boolean')expressFail(400,'invalid_express_filter');
 if(!['documents','plans'].includes(options.productType||'documents'))expressFail(400,'invalid_express_product_type');
 let rows=(quotedRows||expressShopList(store,user,{location,fulfillmentMode,includeClosed:true,productType:options.productType},at))
  .filter(row=>(!shopsOnly||row.printerType==='shop')&&(!verifiedOnly||row.verified));
 const expandedZones=[];
 if(sort==='nearby'||sort==='nearest') {
  const zones=['A'];
  for(const code of ['B','C']) {
   if(rows.filter(row=>row.selectable&&zones.includes(row.zone.code)).length>=3)break;
   zones.push(code);expandedZones.push(code);
  }
  rows=rows.filter(row=>zones.includes(row.zone.code));
 }
 if(sort==='lowest_price'&&!options.files?.some(file=>file.paper==='a3'||file.productType==='plans')&&options.productType!=='plans')expressFail(400,'express_shop_pricing_required');
 rows.sort((a,b)=>Number(b.selectable)-Number(a.selectable)
  ||(sort==='fastest'?Date.parse(a.readyAt||'9999-01-01')-Date.parse(b.readyAt||'9999-01-01')
   :sort==='top_rated'?(b.rating?.average||0)-(a.rating?.average||0)
   :sort==='lowest_price'?(a.quote?.clientItemSubtotalMinor??Infinity)-(b.quote?.clientItemSubtotalMinor??Infinity)
   :sort==='fewest_jobs'?a.jobsAhead-b.jobsAhead:0)
  ||a.distanceMeters-b.distanceMeters||a.supplierId.localeCompare(b.supplierId));
 return {shops:rows,sort,expandedZones,expanded:expandedZones.length>0,
  expansionReason:expandedZones.length?'fewer_than_three_open_printers':null,
  fareBands:structuredClone(store.settings.deliveryFeeBands),walkingEstimateSource:'straight_line_80m_per_minute'};
}

export function fastestPermittedPrinter(choices,fareLimit) {
 if(!['nearby','up_to_149','any'].includes(fareLimit))expressFail(400,'invalid_express_fare_limit');
 const rows=choices.shops.filter(shop=>shop.selectable
  &&(fareLimit==='any'||fareLimit==='nearby'&&shop.zone.code==='A'
   ||fareLimit==='up_to_149'&&shop.deliveryFareMinor<=14900));
 rows.sort((a,b)=>Date.parse(a.readyAt)-Date.parse(b.readyAt)||a.distanceMeters-b.distanceMeters||a.supplierId.localeCompare(b.supplierId));
 if(!rows.length)expressFail(409,'express_shop_unavailable');
 return rows[0];
}
