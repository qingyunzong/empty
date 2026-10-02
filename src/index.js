import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { check } from './checker.js';
import { compile } from './compiler.js';

export function compileSource(source) {
  return compile(check(parse(tokenize(source))));
}

export { tokenize } from './lexer.js';
export { parse } from './parser.js';
export { check } from './checker.js';
export { compile } from './compiler.js';
export { VM } from './vm.js';
export { DslError, DslErrorList } from './errors.js';
