/**
 * Exact two-phase simplex (dictionary form, Bland's rule) over rationals.
 *
 * Solves:  max c·x  s.t.  a_i·x (<=|>=|=) b_i,  x >= 0,
 * with n <= MAX_VARS variables and m <= MAX_CONSTRAINTS constraints.
 *
 * Every result carries an exact, independently checkable certificate:
 *  - optimal:    primal x*, dual y* with c·x* = b·y* (strong duality)
 *  - infeasible: Farkas vector y, A^T y >= 0, b·y < 0 (sign-restricted)
 *  - unbounded:  feasible point x0 and ray d >= 0 with c·d > 0
 */
import { Frac, FracInput } from './rational.js';
export declare const MAX_VARS = 6;
export declare const MAX_CONSTRAINTS = 12;
export type Relation = '<=' | '>=' | '=';
export interface ConstraintInput {
    a: readonly FracInput[];
    rel: Relation;
    b: FracInput;
}
export interface LPInput {
    numVars: number;
    objective: readonly FracInput[];
    constraints: readonly ConstraintInput[];
}
export type SolveResult = {
    status: 'optimal';
    value: Frac;
    x: Frac[];
    y: Frac[];
} | {
    status: 'infeasible';
    farkas: Frac[];
} | {
    status: 'unbounded';
    x0: Frac[];
    ray: Frac[];
};
interface ParsedLP {
    n: number;
    c: Frac[];
    A: Frac[][];
    rel: Relation[];
    b: Frac[];
}
export declare function parseLP(input: LPInput): ParsedLP;
export declare function solveLP(input: LPInput): SolveResult;
export {};
