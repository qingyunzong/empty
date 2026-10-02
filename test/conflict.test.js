'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPolicy } = require('../lib/policy');
const { decide } = require('../lib/evaluate');

const AT = '2026-01-01T00:00:00Z';

test('explicit deny beats allow even when the allow is on a nearer ancestor', () => {
  const policy = loadPolicy(`
{"type":"role","role":"ops","inherits":["base"]}
{"type":"role","role":"base"}
{"type":"rule","id":"r-allow-near","role":"ops","resource":"merchant:7","effect":"allow"}
{"type":"rule","id":"r-deny-far","role":"base","resource":"merchant:7","effect":"deny"}
`);
  const d = decide(policy, { id: 'e1', role: 'ops', resource: 'merchant:7', at: AT });
  assert.equal(d.decision, 'deny');
  assert.equal(d.rule, 'r-deny-far');
  assert.deepEqual(d.conflicts, ['r-allow-near']);
  assert.match(d.reason, /explicit deny/);
});

test('nearer ancestor wins among rules of the same effect', () => {
  const policy = loadPolicy(`
{"type":"role","role":"ops","inherits":["mid"]}
{"type":"role","role":"mid","inherits":["base"]}
{"type":"role","role":"base"}
{"type":"rule","id":"r-far","role":"base","resource":"merchant:7","effect":"allow"}
{"type":"rule","id":"r-near","role":"mid","resource":"merchant:7","effect":"allow"}
`);
  const d = decide(policy, { id: 'e2', role: 'ops', resource: 'merchant:7', at: AT });
  assert.equal(d.decision, 'allow');
  assert.equal(d.rule, 'r-near');
  assert.deepEqual(d.path, ['ops', 'mid']);
});

test('tied rules (same role, same distance, same effect) break by rule id lexicographic', () => {
  const policy = loadPolicy(`
{"type":"role","role":"ops"}
{"type":"rule","id":"r-zulu","role":"ops","resource":"merchant:7","effect":"allow"}
{"type":"rule","id":"r-alpha","role":"ops","resource":"merchant:7","effect":"allow"}
{"type":"rule","id":"r-mike","role":"ops","resource":"merchant:7","effect":"allow"}
`);
  const d = decide(policy, { id: 'e3', role: 'ops', resource: 'merchant:7', at: AT });
  assert.equal(d.decision, 'allow');
  assert.equal(d.rule, 'r-alpha');
  assert.deepEqual(d.conflicts.sort(), ['r-mike', 'r-zulu']);
});

test('deny beats allow on the same role; wildcard patterns compete with exact rules', () => {
  const policy = loadPolicy(`
{"type":"role","role":"ops"}
{"type":"rule","id":"r-allow-exact","role":"ops","resource":"merchant:7","effect":"allow"}
{"type":"rule","id":"r-deny-wild","role":"ops","resource":"merchant:*","effect":"deny"}
`);
  const d = decide(policy, { id: 'e4', role: 'ops', resource: 'merchant:7', at: AT });
  assert.equal(d.decision, 'deny');
  assert.equal(d.rule, 'r-deny-wild');
});

test('default deny when nothing matches', () => {
  const policy = loadPolicy(`
{"type":"role","role":"ops"}
{"type":"rule","id":"r1","role":"ops","resource":"merchant:7","effect":"allow"}
`);
  const d = decide(policy, { id: 'e5', role: 'ops', resource: 'merchant:8', at: AT });
  assert.equal(d.decision, 'deny');
  assert.equal(d.reason, 'no_matching_rule');
});
