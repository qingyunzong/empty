'use strict';

const { lex } = require('../src/lexer');
const { parse } = require('../src/parser');
const { check } = require('../src/types');
const { compile } = require('../src/compiler');
const { VM } = require('../src/vm');

function compileSrc(src) {
  return compile(check(parse(lex(src))));
}

function evalGlobal(src, slot = 0) {
  const vm = new VM(compileSrc(src), []);
  return vm.globals[slot];
}

function expectErr(fn, code) {
  try {
    fn();
  } catch (e) {
    if (e && e.code === code) return e;
    throw new Error(`expected ${code} but got ${e && e.code}: ${e && e.message}`);
  }
  throw new Error(`expected ${code} but no error was thrown`);
}

module.exports = { compileSrc, evalGlobal, expectErr };
