export { tri, type Tri } from './threeval.js';
export { evalExpr, type Expr, type Row, type Scalar } from './expr.js';
export {
  createPolicySnapshot,
  DEFAULT_MASK_REPLACEMENT,
  type MaskRule,
  type Policy,
  type PolicySnapshot,
} from './policy.js';
export { createTable, rowId, type RowId, type Table } from './table.js';
export {
  runQuery,
  type AggregateFn,
  type AggregateSpec,
  type OutputRow,
  type Query,
} from './engine.js';
export { runAuthorizeThenQuery } from './model.js';
export { verifyAgainstModel, type Verification } from './verify.js';
