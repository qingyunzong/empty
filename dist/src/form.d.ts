import { Expr } from './expr.js';
export interface FieldDef {
    name: string;
    condition: Expr;
}
export interface RoundInfo {
    /** 1-based round index of the fixed-point iteration. */
    round: number;
    /** Fields that became visible in this round. */
    revealed: string[];
    /** Sorted snapshot of the full visible set after this round. */
    visibleAfter: string[];
}
export interface VisibilityResult {
    visible: ReadonlySet<string>;
    rounds: RoundInfo[];
}
/**
 * Least fixed point of the visibility operator, computed by monotone
 * iteration starting from the all-hidden state. Each round evaluates all
 * still-hidden fields against the visible set of the previous round
 * (round-atomic), so the visible set only grows.
 */
export declare function computeVisibility(fields: readonly FieldDef[], values: Readonly<Record<string, boolean | undefined>>): VisibilityResult;
export interface BatchResult extends VisibilityResult {
    /** Fields newly visible compared to the state before the batch. */
    becameVisible: string[];
    /** Fields newly hidden compared to the state before the batch. */
    becameHidden: string[];
}
export declare class UnknownFieldError extends Error {
    constructor(name: string);
}
export declare class Form {
    readonly fields: readonly FieldDef[];
    private readonly fieldNames;
    private values;
    private state;
    constructor(fields: readonly FieldDef[], initialValues?: Readonly<Record<string, boolean | undefined>>);
    get visible(): ReadonlySet<string>;
    isVisible(name: string): boolean;
    /** Value as seen by consumers: hidden fields are unfilled (undefined). */
    effectiveValue(name: string): boolean | undefined;
    effectiveValues(): Record<string, boolean | undefined>;
    /**
     * Applies a whole batch of value changes atomically: the patch is merged
     * first, then visibility is recomputed exactly once as a least fixed
     * point from the all-hidden state. Returns the per-round changes of that
     * iteration plus the diff against the previous state.
     */
    applyBatch(patch: Readonly<Record<string, boolean | undefined>>): BatchResult;
}
