import test from 'node:test';
import assert from 'node:assert/strict';
import { pinWorkerRouteAllowed } from '../src/shop-worker-boundary.js';
import { STAFF_ROUTES } from './fixtures/shop-team-routes.js';

test('PIN allowlist preserves shop work and manager tools while refusing carrier identity and future routes', () => {
  for(const [method,path] of STAFF_ROUTES)assert.equal(pinWorkerRouteAllowed(method,path,'staff'),true,`${method} ${path}`);
  for(const role of ['staff','manager'])for(const [method,path] of [
    ['GET','/me/privacy-requests'],['POST','/me/privacy-requests'],['GET','/me/account-deletion-request'],['POST','/me/account-deletion-request'],
    ['POST','/me/account-deletion-request/apple-revocation'],['POST','/auth/clerk/activate'],['POST','/auth/clerk/enroll/supplier'],['POST','/auth/clerk/enroll/rider'],
    ['POST','/auth/staff/redeem'],['GET','/notifications'],['GET','/notifications/stream'],['POST','/devices'],['POST','/web-push/subscribe'],
    ['GET','/me/shop-memberships'],['PATCH','/me/shop-memberships/selected'],['GET','/me'],['PATCH','/me'],['GET','/me/future-personal-route'],
    ['GET','/me/supplier-verification'],['GET','/ops/supplier-verification'],['GET','/ops/supplier-verification/shop'],
    ['HEAD','/orders/order'],['DELETE','/auth/logout'],
  ])assert.equal(pinWorkerRouteAllowed(method,path,role),false,`${role} ${method} ${path}`);
  for(const [method,path] of [['GET','/me/shop-hours'],['PATCH','/me/shop-hours'],['POST','/me/catalog-items'],['POST','/me/shop-team/invites']]) {
    assert.equal(pinWorkerRouteAllowed(method,path,'manager'),true);
    assert.equal(pinWorkerRouteAllowed(method,path,'staff'),false);
  }
});

test('PIN recovery exceptions are limited to picker, selection, lock, logout and token-checked supplier bootstrap', () => {
  for(const [method,path] of [['GET','/me/shop-team/working'],['POST','/me/shop-team/working/select'],['POST','/me/shop-team/working/lock'],['POST','/auth/logout'],['GET','/auth/me'],['GET','/auth/me/supplier']]) {
    assert.equal(pinWorkerRouteAllowed(method,path,'staff'),true,`${method} ${path}`);
  }
  for(const path of ['/auth/me/client','/auth/me/rider','/auth/me/ops','/auth/me/admin'])assert.equal(pinWorkerRouteAllowed('GET',path,'staff'),false,path);
});
