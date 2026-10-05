export type CouponKind = 'amount' | 'percent';

export interface Coupon {
  id: string;
  kind: CouponKind;
  /** cents off for 'amount'; integer percent 0..100 for 'percent' */
  value: number;
  /** id of another coupon that must also be used on the same order */
  prereq?: string;
  /** coupons sharing a group are mutually exclusive on the same order */
  mutexGroup?: string;
  /** shared coupons may be owned by several orders at once */
  shared?: boolean;
}

export interface OrderSpec {
  id: string;
  /** original amount in integer cents */
  amount: number;
  settled?: boolean;
  /** payment locked at settle time; must not change afterwards */
  lockedAmount?: number;
}

export type SolveStatus = 'optimal' | 'feasible' | 'infeasible';

export interface SolveResult {
  status: SolveStatus;
  /** true when the entire search space was explored within the node budget */
  provenOptimal: boolean;
  /** total payable in cents across all orders (null when infeasible) */
  total: number | null;
  /** couponId -> owning order ids (empty array = unused) */
  ownership: Record<string, string[]>;
  /** orderId -> final amount in cents */
  orderAmounts: Record<string, number>;
  nodesExplored: number;
  budgetExhausted: boolean;
}
