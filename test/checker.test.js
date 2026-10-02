import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { check } from '../src/checker.js';
import { DslErrorList } from '../src/errors.js';
import { MACHINE_DSL } from './helpers.js';

function checkSource(src) {
  return check(parse(tokenize(src)));
}

function checkErrors(src) {
  try {
    checkSource(src);
  } catch (e) {
    assert.ok(e instanceof DslErrorList, `expected DslErrorList, got ${e}`);
    return e.errors;
  }
  assert.fail('expected checker to reject the program');
}

test('valid machine passes the checker', () => {
  const checked = checkSource(MACHINE_DSL);
  assert.equal(checked.signals.length, 7);
  assert.equal(checked.rules.length, 3);
  assert.equal(checked.invariants.length, 3);
});

test('duplicate signal in the same scope is an error with line/col', () => {
  const errors = checkErrors('signal a : input bool\nsignal a : output bool\n');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /duplicate signal 'a'/);
  assert.equal(errors[0].line, 2);
  assert.equal(errors[0].col, 8);
});

test('duplicate enum and duplicate enum value are errors', () => {
  const errors = checkErrors('enum E { a, b }\nenum E { c }\nenum F { x, x }\n');
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /duplicate enum 'E'/);
  assert.equal(errors[0].line, 2);
  assert.match(errors[1].message, /duplicate value 'x' in enum 'F'/);
  assert.equal(errors[1].line, 3);
});

test('device-local signal may shadow a global (lexical scope)', () => {
  const checked = checkSource(`
signal door : input bool = false
signal motor : output bool = false
device d {
  signal door : input bool = true
  rule r when door set motor = true
}
`);
  assert.equal(checked.signals.length, 3);
  assert.equal(checked.signals[2].label, 'd.door');
});

test('duplicate signal inside one device is an error', () => {
  const errors = checkErrors('device d {\n  signal a : input bool\n  signal a : output bool\n}\n');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /duplicate signal 'a' in device 'd' scope/);
  assert.equal(errors[0].line, 3);
});

test('undefined name in guard is an error with position', () => {
  const errors = checkErrors('signal m : output bool = false\ndevice d {\n  rule r when ghost set m = true\n}\n');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /undefined name 'ghost'/);
  assert.equal(errors[0].line, 3);
});

test('type error: not applied to ms operand', () => {
  const errors = checkErrors('signal t : timer ms = 0ms\ninvariant not t\n');
  assert.ok(errors.some((e) => /'not' expects a bool operand but found ms/.test(e.message)));
});

test('type error: comparing bool with ms', () => {
  const errors = checkErrors('signal b : input bool\ninvariant b == 5ms\n');
  assert.ok(errors.some((e) => /cannot compare bool with ms/.test(e.message)));
});

test('type error: relational operator on bool operands', () => {
  const errors = checkErrors('signal b : input bool\ninvariant b >= true\n');
  assert.ok(errors.some((e) => /'>=' expects ms operands/.test(e.message)));
});

test('type error: invariant must be bool', () => {
  const errors = checkErrors('signal t : timer ms = 0ms\ninvariant t\n');
  assert.ok(errors.some((e) => /invariant must be a bool expression but is ms/.test(e.message)));
});

test('type error: rule cannot set an input signal', () => {
  const errors = checkErrors('signal a : input bool\ndevice d {\n  rule r when a set a = false\n}\n');
  assert.ok(errors.some((e) => /cannot set input signal 'a'/.test(e.message)));
});

test('type error: enum literal not in enum', () => {
  const errors = checkErrors(`
enum V { closed, open }
signal v : output V = closed
device d {
  rule r when true set v = sideways
}
`);
  assert.ok(errors.some((e) => /expected a value of enum 'V'/.test(e.message)));
});

test('type error: timer must have type ms', () => {
  const errors = checkErrors('signal t : timer bool\n');
  assert.ok(errors.some((e) => /timer 't' must have type ms/.test(e.message)));
});

test('type error: output cannot have type ms', () => {
  const errors = checkErrors('signal o : output ms\n');
  assert.ok(errors.some((e) => /output 'o' cannot have type ms/.test(e.message)));
});

test('type error: unknown enum in signal type', () => {
  const errors = checkErrors('signal s : input Missing\n');
  assert.ok(errors.some((e) => /unknown enum 'Missing'/.test(e.message)));
});

test('type error: init literal does not match signal type', () => {
  const errors = checkErrors('signal b : input bool = 5ms\n');
  assert.ok(errors.some((e) => /expected a bool literal/.test(e.message)));
});

test('multiple errors are collected and all carry line/col', () => {
  const errors = checkErrors('signal a : input bool\nsignal a : output bool\ninvariant nope\n');
  assert.equal(errors.length, 2);
  for (const e of errors) {
    assert.ok(Number.isInteger(e.line) && e.line >= 1);
    assert.ok(Number.isInteger(e.col) && e.col >= 1);
  }
});
