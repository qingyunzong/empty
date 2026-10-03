import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lexer.js';
import { parse } from '../src/parser.js';

const parseSrc = (src) => parse(lex(src, 'test.dsl'));

test('parses site, task window and precedence relation', () => {
  const prog = parseSrc(`
    site S {
      slots 8
      tariff 1
      task a { power 1 kW duration 15 min window 08:00 .. 12:00 }
      task b { power 1 kW duration 15 min after a }
    }
  `);
  const site = prog.sites[0];
  assert.equal(site.name, 'S');
  const [a, b] = site.tasks;
  const win = a.fields.find((f) => f.field === 'window');
  assert.equal(win.value.start.minutes, 480);
  assert.equal(win.value.end.minutes, 720);
  assert.deepEqual(b.fields.map((f) => f.field), ['power', 'duration', 'after']);
  assert.equal(b.fields[2].value, 'a');
});

test('parses templates and template references', () => {
  const prog = parseSrc(`
    template Pump { power 40 kW duration 60 min }
    site S { slots 8 tariff 1 task p1 : Pump { window 00:00 .. 02:00 } }
  `);
  assert.equal(prog.templates[0].name, 'Pump');
  assert.equal(prog.sites[0].tasks[0].templateRef, 'Pump');
});

test('Pratt parser respects operator precedence in objective', () => {
  const prog = parseSrc('site S { slots 8 tariff 1 objective minimize cost + 2 * peak }');
  const e = prog.sites[0].objective.expr;
  assert.equal(e.kind, 'bin');
  assert.equal(e.op, '+');
  assert.equal(e.left.kind, 'var');
  assert.equal(e.right.kind, 'bin');
  assert.equal(e.right.op, '*');
  assert.equal(e.right.right.name, 'peak');
});

test('parentheses override precedence', () => {
  const prog = parseSrc('site S { slots 8 tariff 1 objective minimize (cost + 2) * peak }');
  const e = prog.sites[0].objective.expr;
  assert.equal(e.op, '*');
  assert.equal(e.left.kind, 'bin');
  assert.equal(e.left.op, '+');
});

test('unary minus binds tighter than binary operators', () => {
  const prog = parseSrc('site S { slots 8 tariff 1 objective minimize -carbon + peak }');
  const e = prog.sites[0].objective.expr;
  assert.equal(e.op, '+');
  assert.equal(e.left.kind, 'neg');
  assert.equal(e.left.expr.name, 'carbon');
});

test('rejects unknown objective variable with position', () => {
  assert.throws(
    () => parseSrc('site S { slots 8 tariff 1 objective minimize foo }'),
    (e) => /unknown objective variable 'foo'/.test(e.message) && e.line === 1,
  );
});

test('rejects invalid time literal', () => {
  assert.throws(
    () => parseSrc('site S { slots 8 tariff 1 maintenance 25:00 .. 26:00 }'),
    /invalid time of day '25:00'/,
  );
});
