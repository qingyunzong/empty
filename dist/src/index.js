import { parse } from './parser.js';
import { Interpreter } from './interpreter.js';
export { parse } from './parser.js';
export { Interpreter } from './interpreter.js';
export { BudgetExhausted, ParseError, ScriptError, } from './values.js';
export const DEFAULT_BUDGET = 100_000;
/**
 * Parse and run a script. Transactional `set(...)` writes are buffered and
 * published to `host` only if the script exits normally; on budget
 * exhaustion or any script error, the host is left untouched.
 */
export function runScript(src, opts = {}) {
    const budget = opts.budget ?? DEFAULT_BUDGET;
    const program = parse(src); // parse errors also leave the host untouched
    const interp = new Interpreter(budget);
    const value = interp.run(program); // throws BudgetExhausted / ScriptError
    // Normal exit: commit buffered writes.
    const writes = {};
    for (const [k, v] of interp.pendingWrites) {
        opts.host?.set(k, v);
        writes[k] = v;
    }
    return { value, steps: interp.stepsUsed, writes };
}
