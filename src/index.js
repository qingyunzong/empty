// Library entry point.
export { tokenize, LexError } from './lexer.js';
export { parse, ParseError } from './parser.js';
export { check, CheckError, FIELDS, LEVELS } from './checker.js';
export { compileRules, matchesDevice } from './compiler.js';
export { evaluateRule, extractAlerts } from './vm.js';
export { EventStore, normalizeTime } from './store.js';
export { Engine } from './engine.js';
export { fullReplay, foldActive } from './replay.js';

import { parse } from './parser.js';
import { check } from './checker.js';
import { compileRules } from './compiler.js';

// Compiles DSL source to executable rules; throws LexError/ParseError/
// CheckError (all carry line/col) on failure.
export function compile(source) {
  return compileRules(check(parse(source)));
}
