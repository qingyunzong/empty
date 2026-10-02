import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSite, parseFragment, ParseError } from '../src/parser.js';

test('解析：目标表达式 Pratt 优先级', () => {
  const site = parseSite('site A { minimize cost + 2 * peak }');
  const e = site.objective.expr;
  assert.equal(e.kind, 'bin');
  assert.equal(e.op, '+');
  assert.equal(e.left.kind, 'var');
  assert.equal(e.right.kind, 'bin');
  assert.equal(e.right.op, '*');
  assert.equal(e.right.left.value, 2);
});

test('解析：括号改变优先级与一元负号', () => {
  const site = parseSite('site A { minimize (cost + 2) * -peak }');
  const e = site.objective.expr;
  assert.equal(e.op, '*');
  assert.equal(e.left.kind, 'bin');
  assert.equal(e.right.kind, 'neg');
});

test('解析：窗口、先后关系、模板继承', () => {
  const site = parseSite(`
    site A {
      template P { power 10 kW duration 60 min window 08:00-20:00 }
      template Q : P { power 20 kW }
      task p1 : P
      task q1 : Q { window 10:00-12:00 }
      order p1 before q1
      maintenance 12:00-13:00
    }
  `);
  assert.equal(site.templates[1].parent, 'P');
  assert.equal(site.tasks[1].fields[0].range.from.text, '10:00');
  assert.deepEqual([site.orders[0].a, site.orders[0].b], ['p1', 'q1']);
  assert.equal(site.maintenance[0].from.text, '12:00');
});

test('解析：语法错误带行列', () => {
  assert.throws(
    () => parseSite('site A {\n  task : P\n}'),
    (e) => e instanceof ParseError && e.line === 2 && e.col === 8,
  );
});

test('解析：增量片段只允许 task/order', () => {
  const frag = parseFragment('task p2 : P order p1 before p2');
  assert.equal(frag.tasks.length, 1);
  assert.equal(frag.orders.length, 1);
  assert.throws(() => parseFragment('capacity 10 kW'), ParseError);
});
