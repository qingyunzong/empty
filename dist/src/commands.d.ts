import { Arbitrary } from "./arbitrary.js";
/**
 * Operation histories for model-based testing. A `Machine` describes how to
 * generate the next operation from the current model state, how to check an
 * operation's precondition, and how to advance the (pure) model.
 *
 * The generated history is the shrinkable value; shrinking removes or
 * simplifies operations but a contract filter guarantees every candidate
 * history still replays cleanly against the model (all preconditions hold).
 */
export interface Machine<Model, Op> {
    initialModel(): Model;
    /** Arbitrary for the next operation, given the current model state. */
    next(model: Readonly<Model>): Arbitrary<Op>;
    /** Input contract: may `op` be applied to `model`? */
    precondition(model: Readonly<Model>, op: Op): boolean;
    /** Pure model transition. Must not mutate `model`. */
    step(model: Readonly<Model>, op: Op): Model;
}
export declare function isValidHistory<Model, Op>(machine: Machine<Model, Op>, ops: readonly Op[]): boolean;
export interface HistoryOptions {
    minLength?: number;
    maxLength?: number;
}
/**
 * Arbitrary operation history. Generation threads the model so only valid
 * operations are produced; the shrink tree is wrapped in a validity filter,
 * so the input contract holds for every shrink candidate.
 */
export declare function operationHistory<Model, Op>(machine: Machine<Model, Op>, opts?: HistoryOptions): Arbitrary<Op[]>;
