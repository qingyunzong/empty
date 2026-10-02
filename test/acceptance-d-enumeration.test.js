import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../src/scheduler.js';
import { MAP, grant, task } from '../fixtures/helpers.mjs';

// Acceptance D: for <= 10 tasks, every record carries reachableZones; each
// zone listed there must be independently confirmable by re-deciding the same
// task against that zone.
function fixtures() {
  const grants = [
    grant('G1', { zone: 'Z-COLD' }),
    grant('G2', {
      zone: undefined,
      shelf: 'S-CH-1',
      clock: { node: 'ops', counter: 2 },
      parents: ['G1'],
    }),
  ];
  const tasks = [
    task('T1', { target: { zone: 'Z-COLD' }, parents: ['G1'] }),
    task('T2', {
      target: { zone: 'Z-CHARGE' },
      parents: ['G2'],
      clock: { node: 'agv-1', counter: 3 },
    }),
    task('T3', {
      target: { zone: 'Z-RESTRICTED' },
      parents: ['G2'],
      clock: { node: 'agv-1', counter: 4 },
    }),
  ];
  return { grants, tasks };
}

test('D: records include reachableZones when task count <= 10', () => {
  const { grants, tasks } = fixtures();
  const { plan, deny } = schedule({ map: MAP, tasks, grants });
  const all = [...plan, ...deny];
  assert.equal(all.length, 3);
  for (const record of all) {
    assert.ok(Array.isArray(record.reachableZones), `record ${record.task} has reachableZones`);
  }
  // T1 only saw G1 (zone grant for Z-COLD); T2 also saw G2 (shelf grant in
  // Z-CHARGE), so Z-CHARGE is reachable for T2 but not for T1.
  assert.deepEqual(plan.find((r) => r.task === 'T1').reachableZones, ['Z-COLD', 'Z-OPEN']);
  assert.deepEqual(plan.find((r) => r.task === 'T2').reachableZones, [
    'Z-CHARGE',
    'Z-COLD',
    'Z-OPEN',
  ]);
});

test('D: enumeration cross-checks against independent per-zone decisions', () => {
  const { grants, tasks } = fixtures();
  const { plan, deny } = schedule({ map: MAP, tasks, grants });
  for (const record of [...plan, ...deny]) {
    const original = tasks.find((t) => t.id === record.task);
    for (const zone of MAP.zones) {
      // Independent re-decision of the same task against each zone.
      const probe = { ...original, target: { zone: zone.id } };
      const result = schedule({ map: MAP, tasks: [probe], grants });
      const decided =
        result.plan.length === 1 && result.plan[0].reason !== 'rescue-override';
      const enumerated = record.reachableZones.includes(zone.id);
      assert.equal(
        enumerated,
        decided,
        `task ${record.task} zone ${zone.id}: enumeration=${enumerated} decision=${decided}`,
      );
    }
    // Target zone membership matches the actual allow/deny outcome.
    const targetAllowed = record.reachableZones.includes(record.zone);
    if (record.decision === 'allow' && record.reason !== 'rescue-override') {
      assert.ok(targetAllowed, `allowed task ${record.task} targets a reachable zone`);
    }
    if (record.decision === 'deny') {
      assert.ok(!targetAllowed, `denied task ${record.task} targets an unreachable zone`);
    }
  }
});

test('D: shelf-level grant inherits reachability to its whole zone only via the zone kind rule', () => {
  // Grant on shelf S-CH-1 (inside Z-CHARGE) makes Z-CHARGE reachable for the
  // holder, but not Z-RESTRICTED.
  const grants = [grant('G1', { zone: undefined, shelf: 'S-CH-1' })];
  const t = task('T1', { target: { zone: 'Z-CHARGE' }, parents: ['G1'] });
  const { plan } = schedule({ map: MAP, tasks: [t], grants });
  assert.deepEqual(plan[0].reachableZones, ['Z-CHARGE', 'Z-OPEN']);
});
