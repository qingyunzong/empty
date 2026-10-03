import { parse } from '../src/parser.js';
import { typecheck } from '../src/typecheck.js';
import { compileProgram } from '../src/compile.js';

export function compile(src) {
  const ast = parse(src);
  const { ops } = typecheck(ast);
  return compileProgram(ast, ops);
}

export const REGISTER_DSL = `
op write(key: string, value: any) sets key = value
op read(key: string) -> any gets key
`;

export const COMMUTE_RULE = `
rule wc {
  commutes write(k, _), write(k, _)
}
`;

let lineCounter = 0;
export function ev(id, over = {}) {
  lineCounter += 1;
  return {
    id, node: 'n1', prev: null, invocation: 1, response: 2, realTime: 1,
    op: 'write', key: 'x', value: 1, line: lineCounter, ...over,
  };
}

// Deterministic PRNG (mulberry32).
export function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
