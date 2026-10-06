export { compare, happensAfter, join, tick } from './vclock.js';
export type { CausalOrder, VectorClock } from './vclock.js';
export type { OpKind, PermissionOp } from './op.js';
export { PermissionStore, grantSurvives, maximalOps } from './permissionStore.js';
export type { EffectivePermission, OpSource } from './permissionStore.js';
