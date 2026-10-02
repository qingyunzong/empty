import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../src/scheduler.js';
import { MAP, grant, task } from '../fixtures/helpers.mjs';

// Acceptance A: life-rescue tasks may override a restricted-zone deny, but
// only with dual authorization, and the override must be auditable.
test('A: rescue override is allowed with two distinct authorizers and audited', () => {
  const grants = []; // no grant at all -> restricted zone denies by default
  const rescue = task('T-RESCUE', {
    type: 'rescue',
    priority: 1,
    target: { shelf: 'S-R-1' },
    authorizers: ['alice', 'bob'],
  });
  const normal = task('T-NORMAL', { target: { shelf: 'S-R-1' } });
  const { plan, deny } = schedule({ map: MAP, tasks: [rescue, normal], grants });

  const allowed = plan.find((r) => r.task === 'T-RESCUE');
  assert.ok(allowed, 'rescue task must be planned');
  assert.equal(allowed.reason, 'rescue-override');
  assert.deepEqual(allowed.exception.authorizers, ['alice', 'bob']);
  assert.match(allowed.exception.audit, /dual authorization/);
  assert.ok(allowed.exception.deniedReasons.includes('no-grant'));

  const denied = deny.find((r) => r.task === 'T-NORMAL');
  assert.ok(denied, 'normal task with same target must be denied');
  assert.ok(denied.reasons.includes('no-grant'));
});

test('A: rescue task without two authorizers is denied, not overridden', () => {
  const solo = task('T-SOLO', {
    type: 'rescue',
    target: { shelf: 'S-R-1' },
    authorizers: ['alice'],
  });
  const { plan, deny } = schedule({ map: MAP, tasks: [solo], grants: [] });
  assert.equal(plan.length, 0);
  assert.ok(deny[0].reasons.includes('rescue-requires-dual-authorization'));
});

test('A: rescue override does not apply to non-restricted zones', () => {
  const coldRescue = task('T-COLD', {
    type: 'rescue',
    target: { zone: 'Z-COLD' },
    authorizers: ['alice', 'bob'],
  });
  const { plan, deny } = schedule({ map: MAP, tasks: [coldRescue], grants: [] });
  assert.equal(plan.length, 0);
  assert.ok(deny[0].reasons.includes('no-grant'));
});

test('A: granted rescue task uses the grant, not the exception path', () => {
  const grants = [grant('G1', { zone: 'Z-RESTRICTED' })];
  const rescue = task('T-R', {
    type: 'rescue',
    target: { zone: 'Z-RESTRICTED' },
    authorizers: ['alice', 'bob'],
    parents: ['G1'],
  });
  const { plan } = schedule({ map: MAP, tasks: [rescue], grants });
  assert.equal(plan[0].reason, 'grant-active');
  assert.deepEqual(plan[0].causalChain, ['G1', 'T-R']);
});
