import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lexer.js';
import { parse } from '../src/parser.js';

const parseSrc = (s) => parse(lex(s));

test('pratt parser respects precedence', () => {
  const prog = parseSrc(`
    class A { fee subscribe(amount: money) -> money {
      return amount + 1.00 * 2bps;
    } }
  `);
  const ret = prog.body[0].members[0].body[0];
  assert.equal(ret.expr.kind, 'bin');
  assert.equal(ret.expr.op, '+');
  assert.equal(ret.expr.r.kind, 'bin');
  assert.equal(ret.expr.r.op, '*');
});

test('parses tier blocks with else arm', () => {
  const prog = parseSrc(`
    class A { fee subscribe(amount: money) -> money {
      let g = tier on amount {
        it < 100.00 -> amount * 120bps,
        it >= 100.00 and it < 500.00 -> amount * 100bps,
        else -> amount * 80bps
      };
      return g;
    } }
  `);
  const tier = prog.body[0].members[0].body[0].expr;
  assert.equal(tier.kind, 'tier');
  assert.equal(tier.arms.length, 3);
  assert.equal(tier.arms[2].cond, null);
  assert.equal(tier.arms[1].cond.kind, 'bin');
  assert.equal(tier.arms[1].cond.op, 'and');
});

test('parses allocate with residual account', () => {
  const prog = parseSrc(`
    class A { fee subscribe(amount: money) -> money {
      allocate amount { ta: 6000bps; channel: 4000bps; residual -> "TA_POOL"; }
      return amount;
    } }
  `);
  const alloc = prog.body[0].members[0].body[0];
  assert.equal(alloc.kind, 'allocate');
  assert.deepEqual(alloc.shares.map((s) => s.account), ['ta', 'channel']);
  assert.equal(alloc.residual, 'TA_POOL');
});

test('parses min/max/clamp calls and params', () => {
  const prog = parseSrc(`
    param floor = 5.00;
    class A {
      param cap = 100.00;
      fee subscribe(amount: money) -> money {
        return clamp(amount, floor, cap);
      }
    }
  `);
  assert.equal(prog.body[0].kind, 'param');
  const call = prog.body[1].members[1].body[0].expr;
  assert.equal(call.kind, 'call');
  assert.equal(call.name, 'clamp');
  assert.equal(call.args.length, 3);
});

test('syntax errors raise E_PARSE', () => {
  assert.throws(() => parseSrc('class A { fee subscribe(amount: money) -> money { return amount } }'), (e) => e.code === 'E_PARSE');
  assert.throws(() => parseSrc('rounding BANKERS;'), (e) => e.code === 'E_PARSE');
});
