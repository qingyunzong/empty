import { lex } from './lexer.js';
import { parse } from './parser.js';
import { check } from './checker.js';
import { compile } from './compiler.js';

export function compilePlan(source) {
  const ast = parse(lex(source));
  const { params } = check(ast);
  return compile(ast, params, source);
}
