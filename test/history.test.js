import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHistory, buildVersions } from '../src/history.js';

const BASE = { id: 'e1', node: 'n1', prev: null, invocation: 1, response: 2, realTime: 1, op: 'write', key: 'x', value: 1 };

test('parses a well-formed history', () => {
  const { events, corrections } = parseHistory(JSON.stringify(BASE));
  assert.equal(events.length, 1);
  assert.equal(corrections.length, 0);
  assert.equal(events[0].id, 'e1');
});

test('invalid JSON reports the line number', () => {
  assert.throws(() => parseHistory(`${JSON.stringify(BASE)}\nnot json`), /line 2: invalid JSON/);
});

test('missing required field reports the line number', () => {
  const bad = { ...BASE };
  delete bad.op;
  assert.throws(() => parseHistory(`${JSON.stringify(BASE)}\n${JSON.stringify(bad)}`), /line 2: missing required field "op"/);
});

test('missing response field means pending, not an error', () => {
  const noResp = { ...BASE };
  delete noResp.response;
  const { events } = parseHistory(JSON.stringify(noResp));
  assert.equal(events[0].response, null);
});

test('duplicate event ids are rejected', () => {
  assert.throws(
    () => parseHistory(`${JSON.stringify(BASE)}\n${JSON.stringify(BASE)}`),
    /line 2: duplicate event id "e1"/);
});

test('non-object lines are rejected', () => {
  assert.throws(() => parseHistory('[1,2,3]'), /line 1: each line must be a JSON object/);
});

test('corrections produce a version chain in realTime order', () => {
  const lines = [
    JSON.stringify(BASE),
    JSON.stringify({ id: 'c2', corrects: 'e1', realTime: 9, op: 'write', key: 'x', value: 3 }),
    JSON.stringify({ id: 'c1', corrects: 'e1', realTime: 5, op: 'write', key: 'x', value: 2 }),
  ].join('\n');
  const versions = buildVersions(parseHistory(lines));
  assert.equal(versions.length, 3);
  assert.equal(versions[0].events[0].value, 1);
  assert.equal(versions[1].events[0].value, 2);
  assert.equal(versions[1].events[0].correctedBy, 'c1');
  assert.equal(versions[2].events[0].value, 3);
  assert.equal(versions[2].missingTarget, false);
});

test('correction of unknown event marks the version as missing its target', () => {
  const lines = [
    JSON.stringify(BASE),
    JSON.stringify({ id: 'c1', corrects: 'ghost', realTime: 5, op: 'write', key: 'x', value: 2 }),
  ].join('\n');
  const versions = buildVersions(parseHistory(lines));
  assert.equal(versions[1].missingTarget, true);
});
