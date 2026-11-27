import test from 'node:test';
import assert from 'node:assert/strict';
import * as colour from '../src/colour-pricing.js';
import * as express from '../src/express-print.js';

test('Express measured document tiers have inclusive configurable Light boundary',()=>{
 assert.equal(typeof express.expressDocumentTier,'function');
 for(const [bps,tier] of [[0,'bw'],[1,'light'],[2500,'light'],[2501,'full']])assert.equal(express.expressDocumentTier(bps,2500),tier);
 assert.equal(express.expressDocumentTier(2000,1500),'full');
});
test('chosen colour pages use their measured tier and unchosen pages become B&W',()=>{
 assert.equal(typeof express.priceExpressPages,'function');
 const result=express.priceExpressPages([{page:1,strongColourBps:0},{page:2,strongColourBps:1500},{page:3,strongColourBps:5000}],
  {colourMode:'choose',colourPages:'2',copies:2},{bw:200,light:400,full:600},2500);
 assert.deepEqual(result.pages.map(p=>[p.tier,p.printColour,p.youSet]),[['bw','bw',false],['light','colour',false],['bw','bw',true]]);
 assert.equal(result.subtotalMinor,1600);
 assert.equal(express.priceExpressPages(result.pages,{colourMode:'all_bw',copies:3},{bw:200,light:400,full:600},2500).subtotalMinor,1800);
 assert.throws(()=>express.priceExpressPages(result.pages,{colourMode:'auto',copies:Number.MAX_SAFE_INTEGER},{bw:200,light:400,full:600},2500),e=>e.code==='invalid_money');
});
test('orientation and layout share the placement used for colour measurement',()=>{
 assert.equal(typeof colour.printedPlacement,'function');
 const page={width:2,height:1,widthMilli:200000,heightMilli:100000,pixels:Buffer.from([255,0,0,255,0,0])};
 const paper={widthMilli:210000,heightMilli:297000};
 assert.deepEqual(colour.printedPlacement(page,paper,'fit_to_paper','portrait'),{targetW:210000,targetH:297000,sourceW:200000,sourceH:100000,scale:1.05,offsetX:0,offsetY:96000});
 assert.ok(Math.abs(colour.measurePrintedColour(page,paper,'fit_to_paper',colour.colourSettings(), 'portrait').strongColourBps-3536)<25);
 assert.ok(colour.measurePrintedColour(page,paper,'fit_to_paper',colour.colourSettings(), 'landscape').strongColourBps>7000);
});
test('Plans normalize exact sizes, one side and Auto orientation, locking blue ink',()=>{
 assert.equal(typeof express.normalizeExpressPrint,'function');
 for(const paper of ['20x30','24x36','30x40','a2','a1','a0']){
  const print=express.normalizeExpressPrint({paper,planType:'blue_paper',colour:'blue',sides:'one',orientation:'auto',layout:'fit_to_paper'},'plans');
  assert.equal(print.ink,'blue');assert.equal(print.paperColour,'blue');assert.equal(print.paper,paper);
 }
 for(const change of [{orientation:'portrait'},{sides:'two'},{colour:'colour'},{paper:'a4'}])assert.throws(()=>express.normalizeExpressPrint({paper:'a2',planType:'blue_paper',colour:'blue',sides:'one',layout:'fit_to_paper',...change},'plans'));
});

test('shop tier rates are validated independently per paper and participate in listing review',async()=>{
 const {parseExpressPricing}=await import('../src/express-print.js');
 const {sensitiveSnapshot}=await import('../src/catalog-review-state.js');
 assert.equal(typeof parseExpressPricing,'function');
 const pricing={a4:{bw:200,light:400,full:600},plans:{whiteprint:{'20x30':{bw:3000,colour:5000}},blue_paper:{'24x36':{blue:6000}}}};
 assert.deepEqual(parseExpressPricing(pricing),pricing);
 for(const value of [{a4:{bw:1.5,light:200,full:300}},{a4:{bw:100,light:200}},{plans:{blue_paper:{a2:{colour:3000}}}},{a4:{bw:100,light:200,full:Number.MAX_SAFE_INTEGER+1}}])assert.throws(()=>parseExpressPricing(value));
 assert.notEqual(sensitiveSnapshot({item:{expressPricing:pricing}}),sensitiveSnapshot({item:{}}));
});

test('Light threshold is a validated Super Admin settings value',async()=>{
 const {validateOperationalSettings,defaultOperationalSettings}=await import('../src/operational-model.js');
 for(const bps of [0,2500,10000])assert.doesNotThrow(()=>validateOperationalSettings({...defaultOperationalSettings(),expressLightColourMaxBps:bps}));
 for(const bps of [-1,10001,25.5,'2500',null])assert.throws(()=>validateOperationalSettings({...defaultOperationalSettings(),expressLightColourMaxBps:bps}),e=>e.status===400&&e.code==='invalid_express_light_colour_threshold');
});
