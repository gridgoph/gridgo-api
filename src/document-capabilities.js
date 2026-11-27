import { CatalogError } from './supplier-catalog.js';
import { expressRates } from './express-orders.js';
import { parseExpressPricing } from './express-print.js';

const fail = field => { throw new CatalogError(400,'invalid_supplier_signup','Choose valid document capabilities and positive integer prices.',{field}); };
export function documentCapabilities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('documents');
  for (const [field,allowed] of [['papers',['short','a4','long','a3']],['colours',['bw','colour']]]) {
    if (!Array.isArray(value[field]) || !value[field].length || value[field].length>allowed.length || value[field].some(v=>!allowed.includes(v))) fail(field);
  }
  if (typeof value.duplex!=='boolean') fail('duplex');
  const result={papers:[...new Set(value.papers)],colours:[...new Set(value.colours)],duplex:value.duplex,a3PricesMinor:{},finishing:{}};
  if(value.pricesMinor!=null) {
    try { result.pricesMinor=parseExpressPricing(value.pricesMinor); } catch { fail('pricesMinor'); }
    if(Object.keys(result.pricesMinor).some(p=>!result.papers.includes(p)) || result.papers.some(p=>!result.pricesMinor[p])
      || !result.papers.includes('long') || !result.papers.some(p=>['a4','short'].includes(p))
      || !['bw','colour'].every(c=>result.colours.includes(c)))fail('pricesMinor');
  }
  const price=n=>Number.isSafeInteger(n)&&n>0;
  if (result.papers.includes('a3')) for (const colour of result.colours) {
    const amount=result.pricesMinor?.a3?.[colour==='bw'?'bw':'full']??value.a3PricesMinor?.[colour];
    if (!price(amount)) fail(`a3PricesMinor.${colour}`);
    result.a3PricesMinor[colour]=amount;
  }
  if (value.finishing!=null && (typeof value.finishing!=='object'||Array.isArray(value.finishing))) fail('finishing');
  for (const [key,amount] of Object.entries(value.finishing||{})) {
    if (!['stapling','binding','photo_paper'].includes(key)||!price(amount)) fail(`finishing.${key}`);
    result.finishing[key]=amount;
  }
  return result;
}

/** Absence preserves released listings. New capabilities fail closed on an explicit unsupported request. */
export function documentRequestSupported(store,item,request={}) {
  const home=store.supplierProfiles?.find(p=>p.userId===item?.supplierId&&p.homePrinter);
  if(home&&(!request.expressPrint||item?.subcategoryCode!=='document_printing'||!['short','a4','long'].includes(request.expressPrint.paper)))return false;
  const service=(store.supplierServices||[]).find(s=>s.id===item?.supplierServiceId);
  const capability=service?.documentCapabilities;
  if (!capability || item?.subcategoryCode!=='document_printing') return true;
  const spec={...(request.structuredSpec||{}),...(request.expressPrint||request)};
  const groups=(store.catalogOptionGroups||[]).filter(g=>g.catalogItemId===item.id);
  const selected=(store.catalogOptions||[]).filter(o=>(request.optionIds||[]).includes(o.id));
  const normalize=value=>String(value||'').trim().toLowerCase();
  const colourCode=value=>/black|b&w|b\/?w|monochrome/.test(normalize(value))?'bw':/colou?r/.test(normalize(value))?'colour':normalize(value);
  const paperCode=value=>/\ba3\b/i.test(value)?'a3':/\ba4\b/i.test(value)?'a4':/short|letter|8[.]5.*11/i.test(value)?'short':/long|folio|legal|8[.]5.*13/i.test(value)?'long':normalize(value);
  const selectedIn=pattern=>selected.find(o=>groups.some(g=>g.id===o.optionGroupId&&pattern.test(g.name.toLowerCase())));
  const paper=paperCode(spec.paper||spec.size||selected.find(o=>o.specBinding?.fieldCode==='size')?.specBinding?.value||'');
  const colour=colourCode(spec.colour||spec.colourMode||selectedIn(/colou?r/)?.label||'');
  const normalizedColour=['black','black_and_white','monochrome','b&w'].includes(colour)?'bw':['color','full_colour','full_color'].includes(colour)?'colour':colour;
  const sides=spec.sides||(/back|two|duplex/.test(normalize(selectedIn(/sides/)?.label))?'two':'one');
  if((paper&&!capability.papers.includes(paper))||(colour&&!capability.colours.includes(normalizedColour))
    ||(['two','duplex','back_to_back'].includes(sides)&&!capability.duplex))return false;
  // Fixed size/colour variants also need to cover the requested work; a
  // shop supporting both colours does not make its B&W listing a colour price.
  for(const group of groups) {
    const options=(store.catalogOptions||[]).filter(o=>o.optionGroupId===group.id&&o.active!==false);
    if(paper&&(/size/i.test(group.name)||options.some(o=>o.specBinding?.fieldCode==='size'))
      && !options.some(o=>paperCode(o.specBinding?.value||o.label)===paper))return false;
    if(colour&&/colou?r/i.test(group.name)&&!options.some(o=>colourCode(o.label)===normalizedColour))return false;
  }
  return true;
}
export function assertDocumentRequest(store,item,request) {
  if (!documentRequestSupported(store,item,request)) throw new CatalogError(409,'document_capability_unavailable','This shop cannot print the requested paper, colour or back-to-back pages.');
}

/** Recovery/manual assignment consume accepted facts, never today's source options. */
export function supplierSupportsDocumentOrder(store,supplierId,order) {
  if(store.supplierProfiles?.some(p=>p.userId===supplierId&&p.homePrinter)
    &&(order.orderType!=='express'||!order.expressOrder?.printSettings?.length||order.expressOrder.printSettings.some(p=>p.productType==='plans'||!['short','a4','long'].includes(p.paper))))return false;
  const services=(store.supplierServices||[]).filter(s=>s.supplierId===supplierId&&s.state==='live'&&s.documentCapabilities);
  if(!services.length)return true;
  const requests=order.expressOrder?.printSettings||(store.orderLineItems||[]).filter(line=>line.orderId===order.id)
    .flatMap(line=>{
      const spec={...(line.structuredSpecSnapshot||{}),...(line.expressPrint||{})};
      for(const option of (store.orderLineItemOptions||[]).filter(o=>o.orderLineItemId===line.id)) {
        if(/colou?r/i.test(option.groupNameSnapshot)&&!spec.colour&&!spec.colourMode)spec.colour=option.optionLabelSnapshot;
        if(/size/i.test(option.groupNameSnapshot)&&!spec.paper&&!spec.size)spec.size=option.optionLabelSnapshot;
        if(/sides/i.test(option.groupNameSnapshot)&&!spec.sides)spec.sides=/back|two|duplex/i.test(option.optionLabelSnapshot)?'two':'one';
      }
      // Historical snapshots lack a product type. Conservatively recognize
      // page pricing, paper sizes and saved print options without consulting
      // a source listing that may have been privately revised or removed.
      const documentFacts=line.expressPrint || spec.subcategoryCode==='document_printing'
        || line.pricingUnitSnapshot==='per_page' || line.pricingBasisSnapshot==='per_page'
        || ['paper','colour','colourMode','sides'].some(key=>spec[key])
        || /\ba[34]\b|short|long|letter|legal|folio|8[.]5.*(?:11|13)/i.test(String(spec.size||''));
      return documentFacts?[spec]:[];
    });
  return requests.every(request=>services.some(service=>documentRequestSupported({supplierServices:[service]},
    {supplierServiceId:service.id,subcategoryCode:'document_printing'},request)));
}

/** One price per size/colour: A3 prices cannot leak into a linear size surcharge. */
export function createSignupDocuments(store,supplierId,capability,{id,at}) {
  const rates=expressRates(store.settings);
  const service={id:id('svc'),supplierId,categoryCode:'document_publication',state:'pending_verification',
    pricingBasis:'per_page',referenceRateMinor:Math.min(...(capability.pricesMinor?Object.values(capability.pricesMinor).flatMap(p=>Object.values(p)):capability.colours.map(c=>rates[c==='bw'?'bwMinor':'colourMinor']))),
    turnaroundHours:1,turnaroundMinutes:60,standardTurnaroundHours:1,standardTurnaroundMinutes:60,
    documentCapabilities:structuredClone(capability),version:1,createdAt:at,updatedAt:at};
  (store.supplierServices||=[]).push(service);
  (store.supplierServiceFileFormats||=[]).push({supplierServiceId:service.id,formatCode:'pdf'});
  store.catalogItems||=[];store.catalogOptionGroups||=[];store.catalogOptions||=[];
  const listing=(name,price,subcategoryCode,pricingUnit)=>{
    const item={id:id('sci'),supplierId,supplierServiceId:service.id,subcategoryCode,name,description:'',basePriceMinor:price,
      pricingUnit,turnaroundMode:'inherit',fileFormatMode:'inherit',reviewStatus:'pending',approvedSnapshot:null,active:true,
      express:subcategoryCode==='document_printing',printLayouts:subcategoryCode==='document_printing'?['fit_to_paper','actual_size_centered','actual_size_original_position']:[],
      sortOrder:store.catalogItems.filter(i=>i.supplierId===supplierId).length,version:1,createdAt:at,updatedAt:at};
    store.catalogItems.push(item);return item;
  };
  const group=(item,name,values,field)=>{
    const row={id:id('cog'),catalogItemId:item.id,name,kind:'spec',required:true,sortOrder:store.catalogOptionGroups.filter(g=>g.catalogItemId===item.id).length,version:1,createdAt:at,updatedAt:at};
    store.catalogOptionGroups.push(row);
    values.forEach((value,sortOrder)=>store.catalogOptions.push({id:id('cop'),optionGroupId:row.id,label:value,
      priceModifierMinor:0,specBinding:field?{fieldCode:field,value}:null,active:true,sortOrder,version:1,createdAt:at,updatedAt:at}));
  };
  for (const paper of capability.papers) for (const colour of capability.colours) {
    const price=capability.pricesMinor?.[paper]?.[colour==='bw'?'bw':'full']??(paper==='a3'?capability.a3PricesMinor[colour]:rates[colour==='bw'?'bwMinor':'colourMinor']);
    const item=listing(`${paper.toUpperCase()} ${colour==='bw'?'B&W':'Colour'} documents`,price,'document_printing','per_page');
    if(capability.pricesMinor) {
      item.expressPricing={[paper]:structuredClone(capability.pricesMinor[paper])};
      item.signupDocumentStandard=paper!=='a3';
    }
    group(item,'Paper size',[paper.toUpperCase()],'size');
    group(item,'Colour',[colour==='bw'?'B&W':'Colour']);
    group(item,'Sides',capability.duplex?['One side','Back-to-back']:['One side']);
  }
  for (const [key,amount] of Object.entries(capability.finishing)) {
    const item=listing({stapling:'Stapling',binding:'Binding',photo_paper:'Photo paper printing'}[key],amount,
      key==='photo_paper'?'document_printing':'binding_hardbound',key==='photo_paper'?'per_page':'per_unit');
    item.express=false;
    group(item,'Service',[item.name]);
  }
  return [service];
}
