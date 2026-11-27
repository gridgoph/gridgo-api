import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyReviewTags, ratingTags, visibleReviewComment, shopRatingsSummary } from '../src/shop-rating.js';
const AT = '2026-11-27T10:00:00.000Z';

test('structured tags enforce the score group and count a selection once', () => {
  assert.deepEqual(ratingTags(['Clear print','Accepted fast','Clear print'], 5), ['Clear print','Accepted fast']);
  assert.deepEqual(ratingTags(undefined, 1), []);
  for (const [tags, stars] of [[['Friendly'],2], [['Rude'],4], [['Other'],5], ['Friendly',5], [null,5]]) {
    assert.throws(() => ratingTags(tags, stars), { code:'invalid_rating_tags' });
  }
});
test('only one complete known legacy Tags line converts without changing its comment', () => {
  assert.deepEqual(legacyReviewTags('Good work.\nTags: Clear print, Accepted fast',5), ['Clear print','Accepted fast']);
  assert.deepEqual(legacyReviewTags('Tags: Faded print · Wrong settings',2), ['Faded print','Wrong settings']);
  assert.deepEqual(legacyReviewTags('Tags: Friendly\nMore words',5), ['Friendly']);
  assert.deepEqual(legacyReviewTags('Before\r\nTags: Friendly\r\nAfter',5), ['Friendly']);
  for (const comment of ['Tags: Friendly, unknown','Good Tags: Friendly','Tags: Friendly\nTags: Clear print','Tags: Friendly,', 'Tags: Rude']) {
    assert.deepEqual(legacyReviewTags(comment,5), []);
  }
});
test('review display suppresses contact, account numbers, links and address disclosures', () => {
  for (const text of ['Call 0912 345 6789','Pay 123456789012','Visit https://example.invalid/x','example dot com',
    'Unit 8, 42 Cedar Street','12 Cedar Lane','House 8','Building 4','#42 Cedar','Near the blue gate','Address: Cedar Grove','Brgy. Oakfield',
    '7.12345, 125.6789', 'Pick up at Cedar Grove', 'Beside the red kiosk']) {
    assert.equal(visibleReviewComment(text), null, text);
  }
  assert.equal(visibleReviewComment('Clear print. Ready before I got there.'), 'Clear print. Ready before I got there.');
  assert.equal(visibleReviewComment('Great at Secret Orchard', ['Secret Orchard']), null);
});
function fixture() {
  const scores=[5,5,4,3,1];
  const orders=scores.map((_,i)=>({id:`o${i}`,supplierId:'shop',state:'completed'}));
  const shopReviews=scores.map((qualityStars,i)=>({id:`r${i}`,orderId:`o${i}`,supplierId:'shop',clientId:'client',qualityStars,
    tags:i<3?['Clear print','Friendly']:['Faded print'],comment:i===4?'Call 09123456789':'Nice print',createdAt:`2026-11-${20+i}T00:00:00.000Z`}));
  const offer=(id,status,seconds,extra={})=>({id,supplierId:'shop',state:'cancelled',orderType:'express',expressOrder:{acceptFlow:2,
    events:status==='declined'?[{state:status,supplierId:'shop',at:`2026-11-27T09:00:${seconds}.000Z`}]:[]},
    shopAcceptance:{supplierId:'shop',assignedAt:'2026-11-27T09:00:00.000Z',status,
      ...(status==='accepted'?{acceptedAt:`2026-11-27T09:00:${seconds}.000Z`}:{})},...extra});
  orders.push(offer('accepted','accepted','20'),offer('declined','declined','10'),offer('timeout','timed_out','00'),
    offer('pending','pending','00'),offer('withdrawn','withdrawn','00'),offer('test','accepted','02',{reviewData:true}),
    offer('old','accepted','01',{shopAcceptance:{supplierId:'shop',status:'accepted',assignedAt:'2026-10-01T00:00:00.000Z',acceptedAt:'2026-10-01T00:00:01.000Z'}}));
  orders.push({id:'queue',supplierId:'shop',state:'production'});
  return {orders,shopReviews,users:[{id:'client',name:'Mira Willow Hart',email:'private@example.invalid'}]};
}
test('shop summary uses quality, five descending bars, deduplicated tags, resolved offers and a private latest review', () => {
  const store=fixture(),result=shopRatingsSummary(store,'shop',AT);
  assert.equal(result.average,3.6);assert.equal(result.count,5);
  assert.deepEqual(result.starBars,[{stars:5,count:2},{stars:4,count:1},{stars:3,count:1},{stars:2,count:0},{stars:1,count:1}]);
  assert.deepEqual(result.topTags,[{tag:'Clear print',count:3},{tag:'Friendly',count:3},{tag:'Faded print',count:2}]);
  assert.equal(result.acceptRate.rate,0.3333);assert.equal(result.averageAnswerSeconds,15);assert.equal(result.jobsAhead,1);
  assert.deepEqual(result.latestReview,{reviewer:'Mira H.',qualityStars:1,tags:['Faded print'],comment:null,createdAt:'2026-11-24T00:00:00.000Z'});
  assert.ok(!JSON.stringify(result).includes('private@'));
});
test('four reviews show no rating data; fifth opens summary; marked orders never contribute', () => {
  const store=fixture();store.shopReviews.pop();
  assert.equal(shopRatingsSummary(store,'shop',AT),null);
  store.shopReviews.push({id:'fifth',supplierId:'shop',orderId:'test',qualityStars:5});
  assert.equal(shopRatingsSummary(store,'shop',AT),null);
});

test('summary answer times omit missing, negative, future, old and unresolved answers', () => {
  const store=fixture();
  store.orders=store.orders.filter(order=>!order.expressOrder);
  const add=(id,status,assignedAt,answeredAt)=>store.orders.push({id,supplierId:'shop',state:'cancelled',orderType:'express',expressOrder:{acceptFlow:2,events:[]},
    shopAcceptance:{supplierId:'shop',status,assignedAt,acceptedAt:answeredAt}});
  add('boundary','accepted','2026-10-28T10:00:00.000Z','2026-10-28T10:00:01.000Z');
  add('negative','accepted','2026-11-27T09:00:00.000Z','2026-11-27T08:59:59.000Z');
  add('future','accepted','2026-11-27T09:00:00.000Z','2026-11-28T00:00:00.000Z');
  add('missing','accepted','2026-11-27T09:00:00.000Z',undefined);
  add('open','pending','2026-11-27T09:00:00.000Z','2026-11-27T09:00:20.000Z');
  let result=shopRatingsSummary(store,'shop',AT);
  assert.equal(result.averageAnswerSeconds,null);
  assert.equal(result.acceptRate.offered,3);
  add('valid','accepted','2026-11-27T09:00:00.000Z','2026-11-27T09:00:09.000Z');
  result=shopRatingsSummary(store,'shop',AT);
  assert.equal(result.averageAnswerSeconds,9);
  assert.equal(result.acceptRate.offered,4);
});
test('summaries isolate shops, count repeated legacy selections once and use safe reviewer names', () => {
  const store=fixture();
  store.shopReviews[0].tags=['Clear print','Clear print','Friendly'];
  store.shopReviews.push({id:'unrelated',orderId:'unrelated',supplierId:'other',qualityStars:1,tags:['Rude']});
  store.users[0].name='https://example.invalid';
  let result=shopRatingsSummary(store,'shop',AT);
  assert.equal(result.count,5);assert.equal(result.topTags[0].count,3);
  assert.equal(result.latestReview.reviewer,'Client');
  store.users[0].name='Mira';
  result=shopRatingsSummary(store,'shop',AT);
  assert.equal(result.latestReview.reviewer,'Mira');
  assert.equal(shopRatingsSummary(store,'other',AT),null);
});
