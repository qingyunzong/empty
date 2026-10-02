'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPolicy } = require('../lib/policy');
const { LineError } = require('../lib/jsonl');

function cycleError(text) {
  try {
    loadPolicy(text);
  } catch (e) {
    assert.ok(e instanceof LineError, `expected LineError, got ${e}`);
    assert.equal(e.code, 'E_CYCLE');
    return e;
  }
  assert.fail('expected loadPolicy to throw E_CYCLE');
}

test('two-role cycle reports E_CYCLE at the line that closes the loop', () => {
  const err = cycleError(`
{"type":"role","role":"a","inherits":["b"]}
{"type":"role","role":"b","inherits":["a"]}
`);
  assert.equal(err.line, 3);
});

test('self-inheritance reports E_CYCLE', () => {
  const err = cycleError('{"type":"role","role":"a","inherits":["a"]}');
  assert.equal(err.line, 1);
});

test('longer cycle through multiple roles reports E_CYCLE', () => {
  const err = cycleError([
    '{"type":"role","role":"a","inherits":["b"]}',
    '{"type":"role","role":"b","inherits":["c"]}',
    '{"type":"role","role":"c","inherits":["d"]}',
    '{"type":"role","role":"d","inherits":["b"]}',
  ].join('\n'));
  assert.equal(err.line, 4);
});

test('diamond inheritance is a DAG, not a cycle', () => {
  const policy = loadPolicy([
    '{"type":"role","role":"top","inherits":["l","r"]}',
    '{"type":"role","role":"l","inherits":["base"]}',
    '{"type":"role","role":"r","inherits":["base"]}',
    '{"type":"role","role":"base"}',
  ].join('\n'));
  assert.ok(policy.roles.has('top'));
});
