import { lex } from './lexer.js';
import { parse } from './parser.js';
import { check } from './check.js';
import { compileOps } from './compile.js';
import { VM } from './vm.js';

export { CorpError } from './errors.js';
export { VM } from './vm.js';
export { lex } from './lexer.js';
export { parse } from './parser.js';
export { check } from './check.js';
export { compileOps, hashParts } from './compile.js';

export function compile(src) {
  return compileOps(check(parse(lex(src))));
}

export function run(src, lotsInput) {
  const vm = new VM(lotsInput);
  return vm.run(compile(src));
}
