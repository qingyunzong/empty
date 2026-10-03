import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lexLine } from '../src/lexer.js';
import { parseLine } from '../src/parser.js';
import { checkEvent } from '../src/check.js';
import { compile, VM, DslError, formatScaled } from '../src/index.js';
import { evalAst, toScaled, SCALE, runCode, compileExpr } from '../src/expr.js';

test('lexer: trade line tokens', () => {
  const toks = lexLine('trade T1 v1 2026-10-03 buy 1000 CNE000000001 @ 10.5 gross fee 30');
  const types = toks.map((t) => t.t);
  assert.deepEqual(types, ['kw', 'id', 'ver', 'date', 'kw', 'num', 'id', 'at', 'num', 'kw', 'kw', 'num', 'eof']);
  assert.equal(toks[2].v, 1);
  assert.equal(toks[3].v, '2026-10-03');
});

test('lexer: comments and blank lines', () => {
  assert.equal(parseLine('# hello', 1), null);
  assert.equal(parseLine('   ', 1), null);
  assert.equal(parseLine('deposit 2026-10-03 CNE000000001 qty 5 # trailing', 1).kind, 'deposit');
});

test('pratt: precedence, parens, unary minus', () => {
  const ev = parseLine('trade T1 v1 2026-10-03 buy 1 CNE000000001 @ 1 + 2 * 3 gross', 1);
  assert.equal(evalAst(ev.priceExpr, {}), 7n * SCALE);
  const ev2 = parseLine('trade T1 v1 2026-10-03 buy 1 CNE000000001 @ (1 + 2) * 3 gross', 1);
  assert.equal(evalAst(ev2.priceExpr, {}), 9n * SCALE);
  const ev3 = parseLine('trade T1 v1 2026-10-03 buy 1 CNE000000001 @ 10 - 2 * 4 gross', 1);
  assert.equal(evalAst(ev3.priceExpr, {}), 2n * SCALE);
});

test('pratt: fee expression with variables, div and mod', () => {
  const ev = parseLine('trade T1 v1 2026-10-03 buy 100 CNE000000001 @ 10 gross fee qty * price * 0.0003 + 1', 1);
  const fee = evalAst(ev.feeExpr, { qty: 100n * SCALE, price: 10n * SCALE, accrued: 0n });
  assert.equal(fee, 300000n + 1000000n); // 0.3 + 1
  const ev2 = parseLine('trade T1 v1 2026-10-03 buy 7 CNE000000001 @ 10 gross fee qty / 2 + qty % 2', 1);
  const fee2 = evalAst(ev2.feeExpr, { qty: 7n * SCALE, price: 10n * SCALE, accrued: 0n });
  assert.equal(fee2, 3500000n + 1000000n); // 3.5 + 1
});

test('bytecode: stack machine agrees with tree-walk', () => {
  const ev = parseLine('trade T1 v1 2026-10-03 buy 100 CNE000000001 @ 10 gross fee qty * price * 0.0003 + (1 + 2) * 4', 1);
  const env = { qty: 100n * SCALE, price: 10n * SCALE, accrued: 0n };
  assert.equal(runCode(compileExpr(ev.feeExpr), env), evalAst(ev.feeExpr, env));
});

test('static types: equity must be gross, bond must be net', () => {
  assert.throws(() => checkEvent(parseLine('trade T1 v1 2026-10-03 buy 1 CNE000000001 @ 10 net', 1)),
    (e) => e instanceof DslError && e.code === 'E_SIGN');
  assert.throws(() => checkEvent(parseLine('trade T1 v1 2026-10-03 sell 1 CND000000001 @ 99 gross', 1)),
    (e) => e.code === 'E_SIGN');
  assert.equal(checkEvent(parseLine('trade T1 v1 2026-10-03 sell 1 CND000000001 @ 99 net accrued 0.5', 1)).cls, 'bond');
});

test('static types: bad ISIN, negative price, equity accrued, bad fee var', () => {
  assert.throws(() => compile('trade T1 v1 2026-10-03 buy 1 XXE000000001 @ 10 gross'), (e) => e.code === 'E_SIGN');
  assert.throws(() => compile('trade T1 v1 2026-10-03 buy 1 CNE000000001 @ 5 - 10 gross'), (e) => e.code === 'E_SIGN');
  assert.throws(() => compile('trade T1 v1 2026-10-03 buy 1 CNE000000001 @ 10 gross accrued 0.5'), (e) => e.code === 'E_SIGN');
  assert.throws(() => compile('trade T1 v1 2026-10-03 buy 1 CNE000000001 @ 10 gross fee accrued + 1'), (e) => e.code === 'E_SIGN');
  assert.throws(() => compile('trade T1 v1 2026-10-03 buy -1 CNE000000001 @ 10 gross'), (e) => e.code === 'E_SIGN');
});

test('vm: amend direction/instrument flip rejected with E_SIGN', () => {
  const vm = new VM();
  vm.apply(compile('deposit 2026-10-03 CNE000000001 qty 1000 cash 1000000'), 1);
  vm.apply(compile('trade T1 v1 2026-10-03 buy 100 CNE000000001 @ 10 gross'), 2);
  assert.throws(() => vm.apply(compile('amend T1 v2 2026-10-03 sell 100 CNE000000001 @ 10 gross'), 3),
    (e) => e.code === 'E_SIGN');
  assert.throws(() => vm.apply(compile('amend T1 v2 2026-10-03 buy 100 CNE000000002 @ 10 gross'), 4),
    (e) => e.code === 'E_SIGN');
});

test('vm: version/scope errors E_VERSION', () => {
  const vm = new VM();
  vm.apply(compile('deposit 2026-10-03 CNE000000001 qty 1000 cash 1000000'), 1);
  vm.apply(compile('trade T1 v1 2026-10-03 buy 100 CNE000000001 @ 10 gross'), 2);
  assert.throws(() => vm.apply(compile('trade T1 v1 2026-10-03 buy 5 CNE000000001 @ 10 gross'), 3),
    (e) => e.code === 'E_VERSION'); // duplicate id in same scope
  assert.throws(() => vm.apply(compile('amend T9 v2 2026-10-03 buy 5 CNE000000001 @ 10 gross'), 4),
    (e) => e.code === 'E_VERSION'); // unknown id
  assert.throws(() => vm.apply(compile('amend T1 v2 2026-10-04 buy 5 CNE000000001 @ 10 gross'), 5),
    (e) => e.code === 'E_VERSION'); // cross-date scope
  assert.throws(() => vm.apply(compile('cancel T1 v1 2026-10-04'), 6),
    (e) => e.code === 'E_VERSION'); // cross-date cancel
  assert.throws(() => vm.apply(compile('trade T2 v2 2026-10-03 buy 5 CNE000000001 @ 10 gross'), 7),
    (e) => e.code === 'E_VERSION'); // trade must start at v1
});

test('vm: seq ordering and conflict E_SEQ', () => {
  const vm = new VM();
  vm.apply(compile('deposit 2026-10-03 CNE000000001 qty 1000 cash 1000000'), 5);
  assert.throws(() => vm.apply(compile('deposit 2026-10-03 CNE000000001 qty 1'), 3),
    (e) => e.code === 'E_SEQ'); // backwards
  assert.throws(() => vm.apply(compile('deposit 2026-10-03 CNE000000001 qty 1'), 5),
    (e) => e.code === 'E_SEQ'); // same seq, different content
  const r = vm.apply(compile('deposit 2026-10-03 CNE000000001 qty 1000 cash 1000000'), 5);
  assert.equal(r.noop, true); // identical replay: idempotent
});

test('vm: pending tombstone applies when version arrives later', () => {
  const vm = new VM();
  vm.apply(compile('deposit 2026-10-03 CNE000000001 qty 1000 cash 1000000'), 1);
  vm.apply(compile('trade T1 v1 2026-10-03 buy 100 CNE000000001 @ 10 gross'), 2);
  vm.apply(compile('cancel T1 v3 2026-10-03'), 3); // v3 does not exist yet: pending, not an error
  vm.apply(compile('amend T1 v2 2026-10-03 buy 200 CNE000000001 @ 10 gross'), 4);
  vm.apply(compile('amend T1 v3 2026-10-03 buy 300 CNE000000001 @ 10 gross'), 5);
  const eff = vm.state().scopes['2026-10-03'].T1.effective;
  assert.equal(eff.version, 2); // v3 arrived already tombstoned
  assert.equal(vm.state().ledger['2026-10-03|CNE000000001'].frozenCash, '2000');
});

test('vm: concurrent same-number versions tie-break by hash', () => {
  const vm = new VM();
  vm.apply(compile('deposit 2026-10-03 CNE000000001 qty 1000 cash 10000000'), 1);
  vm.apply(compile('trade T1 v1 2026-10-03 buy 100 CNE000000001 @ 10 gross'), 2);
  const a = compile('amend T1 v2 2026-10-03 buy 150 CNE000000001 @ 10 gross');
  const b = compile('amend T1 v2 2026-10-03 buy 250 CNE000000001 @ 10 gross');
  vm.apply(a, 3);
  vm.apply(b, 4);
  const winner = a.hash <= b.hash ? a : b;
  const eff = vm.state().scopes['2026-10-03'].T1.effective;
  assert.equal(eff.hash, winner.hash.slice(0, 12));
});

test('format: scaled decimals', () => {
  assert.equal(formatScaled(toScaled('10.5')), '10.5');
  assert.equal(formatScaled(toScaled('0.000001')), '0.000001');
  assert.equal(formatScaled(-toScaled('2.25')), '-2.25');
  assert.equal(formatScaled(3000000n), '3');
});
