import { Rng } from "./rng.js";
import { Arbitrary, buildArrayTree, filter } from "./arbitrary.js";
import { Tree } from "./tree.js";

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

export function isValidHistory<Model, Op>(
  machine: Machine<Model, Op>,
  ops: readonly Op[],
): boolean {
  let model = machine.initialModel();
  for (const op of ops) {
    if (!machine.precondition(model, op)) return false;
    model = machine.step(model, op);
  }
  return true;
}

export interface HistoryOptions {
  minLength?: number;
  maxLength?: number;
}

/**
 * Arbitrary operation history. Generation threads the model so only valid
 * operations are produced; the shrink tree is wrapped in a validity filter,
 * so the input contract holds for every shrink candidate.
 */
export function operationHistory<Model, Op>(
  machine: Machine<Model, Op>,
  opts: HistoryOptions = {},
): Arbitrary<Op[]> {
  const minLength = opts.minLength ?? 0;
  const maxLength = opts.maxLength ?? 32;
  const raw: Arbitrary<Op[]> = {
    generate(rng: Rng) {
      const len = rng.nextInt(minLength, maxLength);
      const trees: Tree<Op>[] = [];
      let model = machine.initialModel();
      for (let i = 0; i < len; i++) {
        const t = machine.next(model).generate(rng.fork());
        const op = t.value;
        if (!machine.precondition(model, op)) {
          throw new Error("machine.next produced an operation violating its precondition");
        }
        trees.push(t);
        model = machine.step(model, op);
      }
      return buildArrayTree(trees, 0);
    },
  };
  // Contract preservation during shrinking: drop every candidate history
  // whose operations no longer replay against the model.
  return filter(raw, (ops) => isValidHistory(machine, ops));
}
