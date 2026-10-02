import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHistory, buildVersions, check } from '../src/index.js';

test('history: JSON parse error carries the line number', () => {
  assert.throws(
    () => parseHistory('{"invocation":"e1","op":"write","key":"x"}\n{bad}\n', 'h.jsonl'),
    (e) => e.name === 'HistoryError' && e.line === 2 && /invalid JSON/.test(e.message),
  );
});

test('history: missing required field carries the line number', () => {
  assert.throws(
    () => parseHistory('{"invocation":"e1","op":"write"}\n', 'h.jsonl'),
    (e) => e.line === 1 && /missing required field "key"/.test(e.message),
  );
});

test('history: duplicate invocation ids are rejected', () => {
  const text = [
    '{"invocation":"e1","op":"write","key":"x"}',
    '{"invocation":"e1","op":"write","key":"y"}',
  ].join('\n');
  assert.throws(() => buildVersions(parseHistory(text, 'h'), 'h'), /duplicate invocation id "e1"/);
});

test('history: correction to unknown target is a format error', () => {
  const text = [
    '{"invocation":"e1","op":"write","key":"x"}',
    '{"op":"correct","corrects":"nope","replacement":{"op":"write","key":"x"}}',
  ].join('\n');
  assert.throws(() => buildVersions(parseHistory(text, 'h'), 'h'), /unknown invocation "nope"/);
});

test('history: dangling prev is UNKNOWN, not a contradiction', () => {
  const rules = 'rule R { op write(key: string, value: int) -> string; }';
  const history = '{"invocation":"e1","response":"r1","prev":"ghost","realTime":[0,1],"op":"write","key":"x","value":1}';
  const r = check(rules, history);
  assert.equal(r.verdict, 'UNKNOWN');
  assert.match(r.versions[0].certificate.missing[0].reason, /missing causal predecessor/);
});

test('history: sequential corrections produce a version chain', () => {
  const rules = 'rule R { op write(key: string, value: int) -> string; op read(key: string) -> int; }';
  const history = [
    '{"invocation":"e1","response":"r1","realTime":[0,1],"op":"write","key":"x","value":1}',
    '{"invocation":"e2","response":"r2","realTime":[2,3],"op":"read","key":"x","value":5}',
    '{"op":"correct","corrects":"e2","replacement":{"op":"read","key":"x","value":4,"realTime":[2,3],"response":"r2"}}',
    '{"op":"correct","corrects":"e2","replacement":{"invocation":"e3","op":"read","key":"x","value":1,"realTime":[2,3],"response":"r3"}}',
  ].join('\n');
  const r = check(rules, history);
  assert.equal(r.versions.length, 3);
  assert.deepEqual(r.versions.map((v) => v.status), ['SUPERSEDED', 'SUPERSEDED', 'CURRENT']);
  assert.deepEqual(r.versions.map((v) => v.verdict), ['NON_LINEARIZABLE', 'NON_LINEARIZABLE', 'LINEARIZABLE']);
});
