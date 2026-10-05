/**
 * Independent certificate checker. Shares only the rational type and the
 * input parser with the solver; all verification logic is written directly
 * against the ORIGINAL problem formulation, using exact arithmetic only.
 *
 * Primal:   max c·x  s.t.  a_i·x rel_i b_i,  x >= 0
 * Dual:     min b·y  s.t.  A^T y >= c,  y_i >= 0 for '<=', y_i <= 0 for '>=',
 *           y_i free for '='.
 */
import { LPInput, SolveResult } from './lp.js';
/** Throws with a precise reason if the certificate is invalid; returns void otherwise. */
export declare function verifyResult(lp: LPInput, result: SolveResult): void;
