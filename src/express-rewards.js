import { referralChecks } from './tester-invites.js';
import { promotionEligible } from './promotions.js';
import { initVouchers, issueVoucher, generatedVoucherCode } from './vouchers.js';
import { isReviewData } from './review-data.js';

/** One durable campaign per attribution; its unique wallet rows deduplicate both recipients. */
export function awardExpressFriendPass(store,order,previous,{id,at}) {
 if(order.state!=='completed'||previous?.state==='completed'||isReviewData(order)||order.refundDisposition)return false;
 const invite=(store.testerInvites||[]).find(i=>i.clientId===order.clientId && i.inviterId!==i.clientId && Date.parse(i.createdAt)<=Date.parse(order.createdAt));
 if(!invite || referralChecks({...store,testerRewards:store.testerRewards||[]},invite).blocked)return false;
 const first=store.orders.filter(o=>o.clientId===order.clientId&&!isReviewData(o)&&o.state!=='cancelled')
   .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))[0];
 if(first?.id!==order.id)return false;
 const recipients=[invite.clientId,invite.inviterId];
 if(recipients.some(clientId=>!promotionEligible(store,clientId)))return false;
 initVouchers(store);
 const campaignId=`express_friend_${invite.id}`;
 if(store.voucherCampaigns.some(c=>c.id===campaignId))return false;
 const campaign={id:campaignId,purpose:'express_friend_pass',name:'Friend Pass delivery reward',code:generatedVoucherCode(),mode:'assigned',status:'active',
  valueMinor:0,totalLimit:2,perAccountLimit:1,endsAt:null,validityDays:365,createdAt:at,updatedAt:at};
 store.voucherCampaigns.push(campaign);
 for(const clientId of recipients)issueVoucher(store,campaign,clientId,{id,at});
 return true;
}
