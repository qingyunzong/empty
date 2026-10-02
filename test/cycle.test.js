'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPolicy, PolicyError } = require('../lib/index');

test('direct self-inheritance reports E_CYCLE', () => {
  assert.throws(
    () => loadPolicy(JSON.stringify({ type: 'inherit', role: 'a', inherits: 'a' })),
    (err) => err instanceof PolicyError && err.code === 'E_CYCLE' && err.line === 1,
  );
});

test('three-role cycle reports E_CYCLE at the closing edge line', () => {
  const text = [
    JSON.stringify({ type: 'inherit', role: 'a', inherits: 'b' }),
    JSON.stringify({ type: 'inherit', role: 'b', inherits: 'c' }),
    JSON.stringify({ type: 'inherit', role: 'c', inherits: 'a' }),
  ].join('\n');
  assert.throws(
    () => loadPolicy(text),
    (err) => err.code === 'E_CYCLE' && err.line === 3,
  );
});

test('diamond inheritance is a DAG, not a cycle', () => {
  const text = [
    JSON.stringify({ type: 'inherit', role: 'd', inherits: 'b' }),
    JSON.stringify({ type: 'inherit', role: 'd', inherits: 'c' }),
    JSON.stringify({ type: 'inherit', role: 'b', inherits: 'a' }),
    JSON.stringify({ type: 'inherit', role: 'c', inherits: 'a' }),
  ].join('\n');
  assert.doesNotThrow(() => loadPolicy(text));
});

test('cycle introduced later in the file is caught at its own line', () => {
  const text = [
    JSON.stringify({ type: 'inherit', role: 'x', inherits: 'y' }),
    JSON.stringify({ type: 'rule', id: 'r1', role: 'x', resource: 'res', effect: 'allow' }),
    JSON.stringify({ type: 'inherit', role: 'y', inherits: 'z' }),
    JSON.stringify({ type: 'inherit', role: 'z', inherits: 'x' }),
  ].join('\n');
  assert.throws(
    () => loadPolicy(text),
    (err) => err.code === 'E_CYCLE' && err.line === 4,
  );
});

test('malformed JSON line reports E_PARSE with line number', () => {
  const text = '{"type":"role","role":"a"}\n{not json}';
  assert.throws(
    () => loadPolicy(text),
    (err) => err.code === 'E_PARSE' && err.line === 2,
  );
});

test('schema violations report E_SCHEMA', () => {
  assert.throws(
    () => loadPolicy(JSON.stringify({ type: 'rule', id: 'r1', role: 'a', resource: 'x', effect: 'maybe' })),
    (err) => err.code === 'E_SCHEMA',
  );
  assert.throws(
    () => loadPolicy(JSON.stringify({ type: 'mystery' })),
    (err) => err.code === 'E_SCHEMA',
  );
  assert.throws(
    () =>
      loadPolicy(
        `${JSON.stringify({ type: 'rule', id: 'r1', role: 'a', resource: 'x', effect: 'allow' })}\n` +
          JSON.stringify({ type: 'rule', id: 'r1', role: 'b', resource: 'y', effect: 'deny' }),
      ),
    (err) => err.code === 'E_SCHEMA' && err.line === 2,
  );
});
