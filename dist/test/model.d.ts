/**
 * Independent reference model: the "partial-order maximal operations" model.
 *
 * This file deliberately re-implements happens-before from scratch (it does
 * NOT import the library's vclock) so the randomized checks compare two
 * independent implementations of the same spec:
 *
 *   A grant g of permission p is EFFECTIVE iff for every revoke r of p,
 *   g happens strictly after r.  (remove-wins on concurrency)
 *
 *   The reported sources are the poset-MAXIMAL effective grants; when no
 *   grant survives, the poset-maximal revokes explain the revoked state.
 */
import type { PermissionOp } from '../src/op.js';
export interface ModelEntry {
    granted: boolean;
    sources: string[];
    revokedBy: string[];
}
export declare function modelEffective(allOps: readonly PermissionOp[]): Map<string, ModelEntry>;
