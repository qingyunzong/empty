'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Platform } = require('../src/platform');

test('preempt kills only recomputable nodes and preserves materialized evidence', () => {
  const p = new Platform({ cpu: 2, mem: 8 });
  p.submit({ id: 'evidence', materialized: true, duration: 10, bytes: 5 });
  p.submit({ id: 'scratch', duration: 10, bytes: 5 });
  p.schedule({ stopAt: 4 });
  assert.equal(p.nodes.get('evidence').status, 'running');
  assert.equal(p.nodes.get('scratch').status, 'running');
  const killed = p.preempt();
  assert.deepEqual(killed, ['scratch']);
  assert.equal(p.nodes.get('evidence').status, 'running', 'materialized node keeps running');
  assert.equal(p.nodes.get('scratch').status, 'pending');
});

test('acceptance: after preemption children do not consume quota twice', () => {
  const p = new Platform({ cpu: 2, mem: 8, quotas: { alice: 100 } });
  p.submit({ id: 'parent', owner: 'alice', duration: 10, bytes: 8 });
  p.submit({ id: 'child', owner: 'alice', deps: ['parent'], duration: 1, bytes: 4 });
  p.schedule({ stopAt: 5 });
  assert.equal(p.nodes.get('parent').status, 'running');
  p.preempt();
  assert.equal(p.bytesOf('alice'), 0, 'preempted node never consumed quota');
  const { events, completed } = p.schedule();
  assert.deepEqual(completed, ['child', 'parent']);
  assert.equal(p.nodes.get('parent').attempts, 2, 'parent was restarted');
  assert.equal(p.bytesOf('alice'), 12, 'parent+child bytes counted exactly once each');
  const completions = events.filter((e) => e.type === 'complete').map((e) => e.id);
  assert.deepEqual(completions, ['parent', 'child']);
});

test('invalidated-and-recomputed nodes do not double count quota either', () => {
  const p = new Platform({ cpu: 4, mem: 8, quotas: { alice: 100 } });
  p.submit({ id: 'base', owner: 'alice', bytes: 5 });
  p.submit({ id: 'derived', owner: 'alice', deps: ['base'], bytes: 3 });
  p.schedule();
  assert.equal(p.bytesOf('alice'), 8);
  p.invalidate('base');
  assert.equal(p.bytesOf('alice'), 0);
  p.schedule();
  assert.equal(p.bytesOf('alice'), 8, 'recompute consumes quota once');
});
