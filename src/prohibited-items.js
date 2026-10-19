import { productionStarted, refundFail } from './refund-policy.js';
import { supplierArtworkReleased } from './artwork-gates.js';

export const prohibitedItemHold = order => order?.fileCheck?.reasonCode === 'prohibited_item'
  && order.fileCheck.status === 'failed';

export function assertProhibitedItemIntake(order, user) {
  if (!['ops_admin', 'super_admin'].includes(user?.role)) refundFail(403, 'forbidden', 'Operations or Super Admin is required.');
  assertProhibitedItemFileCheck(order);
}

export function assertProhibitedItemFileCheck(order) {
  if (productionStarted(order)) {
    refundFail(409, 'prohibited_item_before_production_only', 'This file-check decision is only available before production starts.');
  }
  if (!['needs_qa', 'client_correction'].includes(order.state) || supplierArtworkReleased(order)) {
    refundFail(409, 'prohibited_item_file_check_required', 'Use this decision while the order is held at the artwork file check.');
  }
}
