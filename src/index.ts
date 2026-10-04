export { MAX_COUPONS, MAX_ORDERS } from './types.js';
export type { Coupon, CouponKind, Order } from './types.js';
export {
  applyCoupon,
  applyCoupons,
  compareIdSequences,
  isLegalSelection,
  optimizeSingleOrder,
  validateCoupons,
  verifySingleOrderPayment,
} from './singleOrder.js';
export type { SingleOrderOptimum } from './singleOrder.js';
export { optimizeAllocation } from './allocator.js';
export type {
  AllocationOptions,
  AllocationResult,
  AllocationStatus,
  LockedOrder,
} from './allocator.js';
export {
  BRUTE_FORCE_MAX_COUPONS,
  BRUTE_FORCE_MAX_ORDERS,
  bruteForceAllocate,
  crossCheckAllocation,
} from './verify.js';
export type { BruteForceResult, CrossCheckResult } from './verify.js';
export { CouponLibrary, DEFAULT_NODE_BUDGET } from './session.js';
export type { LibraryReport, SettledOrderView } from './session.js';
