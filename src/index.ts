import { parse } from './parser.js';
import { Interpreter } from './interpreter.js';
import type { Value } from './values.js';

export { parse } from './parser.js';
export { Interpreter } from './interpreter.js';
export {
  BudgetExhausted,
  ParseError,
  ScriptError,
  type Dict,
  type Value,
} from './values.js';

export interface RunOptions {
  /** Max evaluation steps (each evaluation and loop back-edge costs 1). */
  budget?: number;
  /** Host store receiving transactional writes on normal exit only. */
  host?: Map<string, Value>;
}

export interface RunResult {
  /** Value of the script's return statement, or null. */
  value: Value;
  /** Steps actually consumed. */
  steps: number;
  /** Writes that were published to the host (empty on any failure). */
  writes: Record<string, Value>;
}

export const DEFAULT_BUDGET = 100_000;

/**
 * Parse and run a script. Transactional `set(...)` writes are buffered and
 * published to `host` only if the script exits normally; on budget
 * exhaustion or any script error, the host is left untouched.
 */
export function runScript(src: string, opts: RunOptions = {}): RunResult {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const program = parse(src); // parse errors also leave the host untouched
  const interp = new Interpreter(budget);
  const value = interp.run(program); // throws BudgetExhausted / ScriptError

  // Normal exit: commit buffered writes.
  const writes: Record<string, Value> = {};
  for (const [k, v] of interp.pendingWrites) {
    opts.host?.set(k, v);
    writes[k] = v;
  }
  return { value, steps: interp.stepsUsed, writes };
}
