export { Fraction } from './fraction.js';
export { CaError } from './errors.js';
export { tokenize } from './lexer.js';
export { parse } from './parser.js';
export { evalExpr, buildAction, isValidDate } from './types.js';
export { compile } from './compiler.js';
export { VM } from './vm.js';
export { formatJournal, formatState } from './report.js';

import { parse } from './parser.js';
import { compile } from './compiler.js';
import { VM } from './vm.js';

// Convenience: parse + compile + execute, returns the VM with final state.
export function runSource(src, lotsInput = {}) {
  const program = parse(src);
  const { instructions } = compile(program);
  const vm = new VM(lotsInput);
  vm.run(instructions);
  return vm;
}
