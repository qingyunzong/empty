import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonl } from '../src/parse.js';

test('parses well-formed JSONL and tracks source positions', () => {
  const text = [
    '{"op":"reserve","eventTs":0,"agv":"A","edge":"E1","id":"R1"}',
    '',
    '{"op":"ping","eventTs":5,"agv":"A","node":"N1","speed":0.1,"id":"P1"}',
  ].join('\n');
  const events = parseJsonl(text, 'events.jsonl');
  assert.equal(events.length, 2);
  assert.equal(events[0]._where, 'events.jsonl:1');
  assert.equal(events[1]._where, 'events.jsonl:3');
});

test('rejects invalid JSON with BAD_JSON', () => {
  assert.throws(() => parseJsonl('{not json', 'f.jsonl'), { code: 'BAD_JSON' });
});

test('rejects unknown op with INVALID_EVENT', () => {
  assert.throws(() => parseJsonl('{"op":"jump","eventTs":1}', 'f.jsonl'), {
    code: 'INVALID_EVENT',
  });
});

test('rejects missing required fields', () => {
  assert.throws(() => parseJsonl('{"op":"reserve","eventTs":1,"agv":"A"}', 'f.jsonl'), {
    code: 'INVALID_EVENT',
  });
});

test('rejects non-numeric eventTs', () => {
  const line = '{"op":"cancel","eventTs":"soon","reserveId":"R1"}';
  assert.throws(() => parseJsonl(line, 'f.jsonl'), { code: 'INVALID_EVENT' });
});

test('rejects unknown retract kind', () => {
  const line = '{"op":"retract","eventTs":1,"kind":"edge","id":"E1"}';
  assert.throws(() => parseJsonl(line, 'f.jsonl'), { code: 'INVALID_EVENT' });
});
