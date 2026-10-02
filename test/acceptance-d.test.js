'use strict';

// Acceptance D: enumerate <= 12 subjects and <= 12 tags and cross-check the
// main evaluator against the independent reference evaluator on every
// (subject, event, action) combination.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, referenceEvaluate, ACTIONS } = require('../src/evaluate');

// Deterministic PRNG (mulberry32) so the test is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildPolicy(rand) {
  const tags = Array.from({ length: 12 }, (_, i) => `tag-${i}`);
  const groups = Array.from({ length: 4 }, (_, i) => ({ id: `g${i}`, parents: i === 0 ? [] : [`g${i - 1}`] }));
  const tenants = Array.from({ length: 8 }, (_, i) => ({
    id: `t${i}`,
    parents: rand() < 0.7 ? [`g${Math.floor(rand() * 4)}`] : [],
  }));
  const devices = Array.from({ length: 12 }, (_, i) => ({
    id: `d${i}`,
    tags: [tags[i], ...(rand() < 0.3 ? ['safety-public'] : [])].filter((t, idx, arr) => arr.indexOf(t) === idx),
  }));
  const subjects = [...tenants.map((t) => t.id), ...groups.map((g) => g.id)];
  const rules = [];
  for (let i = 0; i < 40; i++) {
    const rule = {
      id: `r${i}`,
      effect: rand() < 0.7 ? 'allow' : 'deny',
      subject: subjects[Math.floor(rand() * subjects.length)],
      actions: ACTIONS.filter(() => rand() < 0.6),
    };
    if (rule.actions.length === 0) rule.actions = ['read'];
    if (rand() < 0.25) rule.event = `e${Math.floor(rand() * 12)}`; // event-level exception
    else rule.tag = tags[Math.floor(rand() * tags.length)];
    if (rand() < 0.2) rule.revokedAt = '2026-01-01T00:00:00Z';
    rules.push(rule);
  }
  return { tenants, groups, tags, devices, rules };
}

test('D: main evaluator matches reference over all subjects x events x actions (<=12 subjects/tags)', () => {
  const rand = rng(20261002);
  const policy = buildPolicy(rand);
  const subjects = [...policy.tenants.map((t) => t.id), ...policy.groups.map((g) => g.id)];
  assert.ok(subjects.length <= 12);
  assert.ok(policy.tags.length <= 12);
  const events = policy.devices.map((d, i) => ({
    seq: i + 1,
    eventId: `e${i}`,
    deviceId: d.id,
    type: i % 3 === 0 ? 'downtime' : 'vibration',
  }));
  const ats = ['2025-12-01T00:00:00Z', '2026-02-01T00:00:00Z']; // before/after revocations
  let checked = 0;
  for (const at of ats) {
    for (const subject of subjects) {
      for (const event of events) {
        const device = policy.devices.find((d) => d.id === event.deviceId);
        for (const action of ACTIONS) {
          const main = evaluate(policy, subject, event, device, action, at);
          const ref = referenceEvaluate(policy, subject, event, device, action, at);
          assert.equal(main.allow, ref.allow,
            `mismatch: subject=${subject} event=${event.eventId} action=${action} at=${at}`);
          if (ref.brokeDeny) assert.ok(main.brokenDeny, 'broken deny must be recorded');
          if (!main.allow) assert.ok(main.counterexample, 'denial must carry a minimal counterexample');
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 0);
});
