import { Expr } from "./expr";
export interface NaiveStats {
    /** Number of AST nodes evaluated; re-evaluated nodes are counted every time. */
    steps: number;
}
/**
 * Non-shared call-by-name interpreter used to cross-check the shared lazy
 * evaluator. Every variable reference re-evaluates the bound expression;
 * nothing is cached. Self-dependencies are still reported as black holes
 * instead of diverging.
 */
export declare function evaluateNaive(root: Expr, stats?: NaiveStats): number;
