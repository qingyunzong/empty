/**
 * Independent oracle: a deliberately naive, self-contained re-implementation
 * of the sync rules, used to cross-check src/sync.ts on random inputs.
 * It shares no code with the library: equality is JSON-based, state is kept
 * in plain objects, and the control flow is written as flat loops.
 */
import type { Item, MergeDirectives, SyncReport } from '../src/sync.js';
export declare function oracleSync(base: readonly Item[], source: readonly Item[], target: readonly Item[], merge: boolean, directives: MergeDirectives): SyncReport;
