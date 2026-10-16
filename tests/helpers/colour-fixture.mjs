import { fixture, AT } from '../fixtures/reschedule.js';
import { parseColourListing } from '../../src/colour-pricing.js';
import { inspectArtwork } from '../../src/artwork-inspection.js';
import { previewPdf } from './preview-fixtures.mjs';
export function colourFixture({priced=true,missing=false}={}) {
  const store = fixture();
  store.settings.serviceFeeSchedule = {version:2,rounding:'half_up_once',brackets:[{upToMinor:200000,rateBps:4500},{upToMinor:2000000,rateBps:2500},{upToMinor:null,rateBps:1500}]};
  const item = store.catalogItems.find(row=>row.id==='item_supplier');
  Object.assign(item,{pricingUnit:'per_page',printLayouts:['fit_to_paper','actual_size_centered']});
  Object.assign(item,parseColourListing({pricedByColour:priced,oneColour:!priced,colourPricing:priced?{sizes:[{paperSize:'20x30',tierSet:'large_format',prices:missing?{none:3000}:{none:3000,up_to_25:6000,up_to_50:10000,above_50:20000}}]}:null},item));
  store.catalogOptionGroups.push({id:'size_group',catalogItemId:item.id,name:'Paper size',kind:'spec',required:true,sortOrder:0,version:1,createdAt:AT,updatedAt:AT});
  store.catalogOptions.push({id:'20x30',optionGroupId:'size_group',label:'20x30',priceModifierMinor:99999,specBinding:{fieldCode:'size',value:'20x30'},active:true,sortOrder:0,createdAt:AT,updatedAt:AT});
  const bytes = previewPdf();
  store.files.push({fileId:'colour_art',ownerId:'client',purpose:'artwork',state:'ready',objectKey:'private/colour.pdf',originalFilename:'plans.pdf',declaredContentType:'application/pdf',detectedContentType:'application/pdf',size:bytes.length,createdAt:AT,detected:inspectArtwork(bytes,'application/pdf'),artworkCheck:{status:'passed'},references:[]});
  store.files.push({fileId:'colour_proof',ownerId:'client',purpose:'payment_proof',state:'ready',objectKey:'private/proof.png',originalFilename:'proof.png',declaredContentType:'image/png',detectedContentType:'image/png',size:100,createdAt:AT,references:[]});
  return {store,item,bytes,line:{id:'colour_line',catalogItemId:item.id,supplierId:'supplier',optionIds:['20x30'],quantity:3,quantityMode:'document_sets',artworkFileId:'colour_art',printLayout:'fit_to_paper'}};
}
