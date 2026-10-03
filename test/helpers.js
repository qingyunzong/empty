import { lex } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { check } from '../src/checker.js';

export function modelOf(src, file = 'test.dsl') {
  return check(parse(lex(src, file)));
}

export function siteOf(src, file = 'test.dsl') {
  return modelOf(src, file).sites[0];
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
