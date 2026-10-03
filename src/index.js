import { parseLine, parseSource } from './parser.js';
import { compileEvent } from './compile.js';

export { VM, effectiveOf } from './vm.js';
export { DslError, E_PARSE, E_SIGN, E_VERSION, E_NEG, E_SEQ } from './errors.js';
export { SCALE, formatScaled, disassemble } from './expr.js';
export { parseLine, parseSource } from './parser.js';
export { compileEvent } from './compile.js';

// Full front-end pipeline for one DSL line: lex -> parse -> typecheck -> bytecode.
export function compile(text, lineNo = 1) {
  const ast = parseLine(text, lineNo);
  return ast ? compileEvent(ast) : null;
}

export function compileSource(text) {
  return parseSource(text).map((ast) => compileEvent(ast));
}
