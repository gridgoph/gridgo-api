/** Release controls are explicit persisted settings; absent values retain review. */
export const supplierOnboardingSettings = settings => ({autoApproveDocuments:false,unverifiedShopsEnabled:false,...settings?.supplierOnboarding});
export const tierSignup = signup => Boolean(signup?.steps?.prints?.documents?.pricesMinor);
export const missingShopName = name => !String(name||'').trim() || /^temporary$/i.test(String(name).trim());
export function validateSupplierOnboardingSettings(settings) {
  const value=settings?.supplierOnboarding;
  if(value!==undefined && (!value || typeof value!=='object' || Array.isArray(value)
    || Object.keys(value).some(k=>!['autoApproveDocuments','unverifiedShopsEnabled'].includes(k))
    || Object.values(value).some(v=>typeof v!=='boolean'))) {
    throw Object.assign(new Error('invalid_supplier_onboarding_settings'),{status:400,code:'invalid_supplier_onboarding_settings'});
  }
  const guides=settings?.areaPriceGuides;
  if(guides===undefined)return;
  const money=n=>Number.isSafeInteger(n)&&n>0&&n%100===0;
  if(!Array.isArray(guides)||guides.length>100||guides.some(g=>!g||typeof g.name!=='string'||!g.name.trim()||g.name.length>120
    ||!Number.isFinite(g.lat)||Math.abs(g.lat)>90||!Number.isFinite(g.lng)||Math.abs(g.lng)>180
    ||!Number.isSafeInteger(g.radiusMeters)||g.radiusMeters<1||g.radiusMeters>100000
    ||!Array.isArray(g.ranges)||!g.ranges.length||g.ranges.length>12||g.ranges.some(r=>!r||!['a4','short','long','a3'].includes(r.paper)
      ||!['bw','light','full'].includes(r.tier)||!money(r.minMinor)||!money(r.maxMinor)||r.minMinor>r.maxMinor))) {
    throw Object.assign(new Error('invalid_area_price_guides'),{status:400,code:'invalid_area_price_guides'});
  }
}
/** Provenance is server-owned; custom products and paid extras never qualify. */
export function standardSignupDocument(store,item) {
  if(!item?.signupDocumentStandard || item.subcategoryCode!=='document_printing'||item.pricingUnit!=='per_page'||item.express!==true)return false;
  const papers=Object.keys(item.expressPricing||{});
  if(!papers.length||papers.some(p=>!['a4','short','long'].includes(p)))return false;
  return !(store.catalogOptionGroups||[]).some(g=>g.catalogItemId===item.id&&g.kind==='addon');
}
