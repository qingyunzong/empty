'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lex } = require('../src/lexer');
const { compile } = require('../src/compiler');
const {
  replay,
  explain,
  enumerateTopoOrders,
  buildGraph,
} = require('../src/adjudicator');

function run(source) {
  const program = compile(lex(source));
  return { program, result: replay(program) };
}

test('acceptance 1: three-node causal chain yields a unique order', () => {
  const { program, result } = run([
    'note: chain n1 -> n2 -> n3 across nodes',
    'n3 7 commit gamma = g after n2@3',
    'n1 1 commit alpha = a',
    'n2 3 commit beta = b after n1@1',
  ].join('\n'));
  assert.deepEqual(result.order, ['n1@1', 'n2@3', 'n3@7']);
  assert.deepEqual(result.state, { alpha: 'a', beta: 'b', gamma: 'g' });
  assert.equal(result.conflicts.length, 0);
  const { adj, indeg } = buildGraph(
    program.code.filter((i) => i.op !== 4),
    program.edges,
  );
  const all = enumerateTopoOrders(program.code.filter((i) => i.op !== 4), adj, indeg);
  assert.equal(all.length, 1, 'causal chain admits exactly one topological order');
  const text = explain(program, result);
  assert.match(text, /n1@1 -> n2@3/);
  assert.match(text, /n2@3 -> n3@7/);
});

test('acceptance 2: concurrent different values on one key produce a conflict certificate', () => {
  const { result } = run([
    'n1 1 commit prefix = keep',
    'n1 2 commit color = red',
    'n2 5 commit color = blue',
    'n3 9 commit tail = t after n1@1',
  ].join('\n'));
  assert.equal(result.conflicts.length, 1);
  const cert = result.conflicts[0];
  assert.equal(cert.key, 'color');
  assert.deepEqual(
    cert.events.map((e) => `${e.id}=${e.value}`).sort(),
    ['n1@2=red', 'n2@5=blue'],
  );
  assert.equal(cert.causalEdges.length, 0, 'no causal edge connects the conflicting events');
  assert.equal(result.state.prefix, 'keep', 'committed prefix is preserved');
  assert.equal(result.state.tail, 't');
  assert.equal(result.state.color, undefined, 'conflicting events do not enter state');
  const skipped = result.history.filter((h) => h.action === 'skipped-conflict').map((h) => h.id);
  assert.deepEqual(skipped.sort(), ['n1@2', 'n2@5']);
});

test('concurrent same-value writes on one key are not a conflict', () => {
  const { result } = run('n1 1 commit k = v\nn2 2 commit k = v');
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.state.k, 'v');
});

test('acceptance 3a: all topological orders of three concurrent events are enumerated', () => {
  const { program, result } = run([
    'n1 1 commit zebra = z',
    'n2 2 commit apple = a',
    'n3 3 commit mango = m',
  ].join('\n'));
  const events = program.code.filter((i) => i.op !== 4);
  const { adj, indeg } = buildGraph(events, program.edges);
  const all = enumerateTopoOrders(events, adj, indeg);
  assert.equal(all.length, 6, 'three mutually concurrent events have 3! = 6 topological orders');
  assert.deepEqual(
    result.order,
    ['n2@2', 'n3@3', 'n1@1'],
    'deterministic tie-break orders concurrent different keys by key name (apple < mango < zebra)',
  );
  assert.ok(
    all.some((ord) => ord.join(',') === result.order.join(',')),
    'deterministic choice is a valid topological order',
  );
});

test('acceptance 3b: missing clock and duplicate events are errors', () => {
  assert.throws(() => lex('n1 commit k = v'), /logical clock/);
  assert.throws(() => compile(lex('n2 4 commit k = v\nn2 4 mask k')), /duplicate event n2@4/);
});

test('mask hides a key and rollback restores the previous value', () => {
  const { result } = run([
    'n1 1 commit k = first',
    'n1 2 commit k = second',
    'n1 3 rollback k',
    'n2 1 commit hidden = x',
    'n2 2 mask hidden',
  ].join('\n'));
  assert.equal(result.state.k, 'first', 'rollback pops the last commit on the key');
  assert.equal(result.state.hidden, undefined, 'masked key is hidden from state');
});

test('causal cycle is rejected during replay', () => {
  const program = compile(lex([
    'n1 1 commit a = 1 after n2@2',
    'n2 2 commit b = 2 after n1@1',
  ].join('\n')));
  assert.throws(() => replay(program), /causal cycle/);
});

test('explain lists the causal edges used for adjudication', () => {
  const { program, result } = run([
    'n1 1 commit a = 1',
    'n1 2 commit b = 2',
    'n2 1 commit c = 3 after n1@2',
  ].join('\n'));
  const text = explain(program, result);
  assert.match(text, /n1@1 -> n1@2.*same-node clock order/);
  assert.match(text, /n1@2 -> n2@1.*declared "after" dependency/);
  assert.deepEqual(result.order, ['n1@1', 'n1@2', 'n2@1']);
});
