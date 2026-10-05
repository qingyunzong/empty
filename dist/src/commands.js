import { buildArrayTree, filter } from "./arbitrary.js";
export function isValidHistory(machine, ops) {
    let model = machine.initialModel();
    for (const op of ops) {
        if (!machine.precondition(model, op))
            return false;
        model = machine.step(model, op);
    }
    return true;
}
/**
 * Arbitrary operation history. Generation threads the model so only valid
 * operations are produced; the shrink tree is wrapped in a validity filter,
 * so the input contract holds for every shrink candidate.
 */
export function operationHistory(machine, opts = {}) {
    const minLength = opts.minLength ?? 0;
    const maxLength = opts.maxLength ?? 32;
    const raw = {
        generate(rng) {
            const len = rng.nextInt(minLength, maxLength);
            const trees = [];
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
