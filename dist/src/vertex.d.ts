/**
 * Brute-force vertex enumeration, used only as an independent cross-check
 * for small instances. Enumerates every basic solution of the equality
 * system [Ahat | I] z = b, z >= 0 (z = (x, slack)) by exact Gaussian
 * elimination, and keeps the best feasible vertex value.
 *
 * Soundness: the feasible set lies inside the nonnegative orthant, hence is
 * pointed; so a nonempty feasible set always has a basic feasible solution,
 * and a bounded feasible LP always attains its optimum at a vertex.
 */
import { Frac } from './rational.js';
import { LPInput } from './lp.js';
export interface VertexEnumResult {
    feasible: boolean;
    bestValue: Frac | null;
    bestVertex: Frac[] | null;
    basesEnumerated: number;
    feasibleBases: number;
}
/** Exact solve of M z = rhs for a square matrix; null if singular. */
export declare function solveSquare(M: readonly (readonly Frac[])[], rhs: readonly Frac[]): Frac[] | null;
export declare function enumerateVertices(input: LPInput): VertexEnumResult;
