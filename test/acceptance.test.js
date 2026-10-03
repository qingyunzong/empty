import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexMap } from '../src/map.js';
import { schedule } from '../src/scheduler.js';
import { enumerateReachableZones } from '../src/policy.js';
import { buildEventIndex, normalizeEvents } from '../src/events.js';

function makeMap() {
  return indexMap({
    width: 50,
    height: 50,
    zones: [
      { id: 'Z-OPEN', kind: 'normal', aisles: [{ id: 'A-0', shelves: [{ id: 'S-0', x: 1, y: 1 }] }] },
      {
        id: 'Z-RES',
        kind: 'restricted',
        aisles: [{ id: 'A-1', shelves: [{ id: 'S-10', x: 5, y: 5 }, { id: 'S-11', x: 6, y: 6 }] }],
      },
      { id: 'Z-COLD', kind: 'coldchain', aisles: [{ id: 'A-2', shelves: [{ id: 'S-20', x: 20, y: 20 }] }] },
      { id: 'Z-CHG', kind: 'charging', aisles: [{ id: 'A-3', shelves: [{ id: 'S-30', x: 30, y: 30 }] }] },
    ],
  });
}

test('A: life-rescue task overrides restricted-zone deny with dual authorization, fully audited', () => {
  const map = makeMap();
  const tasks = [
    {
      id: 'T-rescue',
      kind: 'rescue',
      priority: 100,
      subject: 'agv-1',
      target: { zone: 'Z-RES', aisle: 'A-1', shelf: 'S-10', x: 5, y: 5 },
      dispatch: { event: 'e-d1', lamport: 1, parents: [], time: 10 },
      dualAuth: ['alice', 'bob'],
    },
    {
      id: 'T-normal-high-prio',
      kind: 'normal',
      priority: 100,
      target: { zone: 'Z-RES', aisle: 'A-1' },
      dispatch: { event: 'e-d2', lamport: 2, parents: [], time: 11 },
    },
  ];
  const { plan, deny } = schedule(map, [], tasks);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].task, 'T-rescue');
  assert.deepEqual(plan[0].exception, {
    type: 'life-rescue-override',
    authorizers: ['alice', 'bob'],
    overriddenReason: 'no-grant-for-target',
  });
  assert.equal(plan[0].zone, 'Z-RES');
  // high priority alone does NOT override a restricted-zone deny
  assert.equal(deny.length, 1);
  assert.equal(deny[0].task, 'T-normal-high-prio');
  assert.equal(deny[0].reason, 'no-grant-for-target');
});

test('B: revocation segments by time; occupying task keeps temp pass, new task denied', () => {
  const map = makeMap();
  const grants = [
    { id: 'g1', op: 'grant', subject: '*', level: 'zone', zone: 'Z-COLD', event: 'e1', lamport: 1, parents: [], time: 0, from: 0, to: 1000 },
    { id: 'r1', op: 'revoke', subject: '*', level: 'zone', zone: 'Z-COLD', event: 'e2', lamport: 2, parents: ['e1'], time: 500 },
  ];
  const tasks = [
    {
      id: 'T-old',
      target: { zone: 'Z-COLD', aisle: 'A-2' },
      occupyUntil: 600,
      dispatch: { event: 'e3', lamport: 3, parents: ['e1'], time: 100 },
    },
    {
      id: 'T-new',
      target: { zone: 'Z-COLD', aisle: 'A-2' },
      dispatch: { event: 'e4', lamport: 4, parents: ['e2'], time: 550 },
    },
  ];
  const { plan, deny } = schedule(map, grants, tasks);
  assert.equal(plan.length, 1);
  const old = plan[0];
  assert.equal(old.task, 'T-old');
  assert.equal(old.permission.grant, 'g1');
  assert.equal(old.permission.level, 'zone');
  assert.match(old.permission.path, /zone:Z-COLD -> aisle:A-2/);
  assert.deepEqual(old.causalChain, ['e1', 'e3']);
  // temp pass retained until completion, covering the mid-task revocation
  assert.equal(old.tempPass.until, 600);
  assert.deepEqual(old.tempPass.revokedBy, ['r1']);
  // new task dispatched after revocation cannot reuse the pass
  assert.equal(deny.length, 1);
  assert.equal(deny[0].task, 'T-new');
  assert.equal(deny[0].reason, 'grant-expired-or-revoked');
  assert.equal(deny[0].tempPass, undefined);
  // counterexample: removing r1 would make T-new legal
  assert.equal(deny[0].counterexamples.length, 1);
  assert.equal(deny[0].counterexamples[0].removeRevocation, 'r1');
  assert.equal(deny[0].counterexamples[0].resultingGrant, 'g1');
  assert.match(deny[0].counterexamples[0].evidence, /t=550/);
});

test('C: out-of-order events resolved by Lamport causality (grant must be seen before dispatch)', () => {
  const map = makeMap();
  const grants = [
    { id: 'g1', op: 'grant', subject: '*', level: 'zone', zone: 'Z-RES', event: 'e1', lamport: 1, parents: [], time: 0, from: 0, to: 1000 },
    { id: 'g2', op: 'grant', subject: '*', level: 'zone', zone: 'Z-COLD', event: 'e5', lamport: 5, parents: ['e1'], time: 0, from: 0, to: 1000 },
  ];
  const tasks = [
    // higher lamport, but causally concurrent with g1: has NOT seen the grant
    { id: 'T-blind', target: { zone: 'Z-RES', aisle: 'A-1' }, dispatch: { event: 'e9', lamport: 9, parents: [], time: 10 } },
    // causally after g1 via g2's event e5
    { id: 'T-seeing', target: { zone: 'Z-RES', aisle: 'A-1' }, dispatch: { event: 'e10', lamport: 10, parents: ['e5'], time: 10 } },
  ];
  const { plan, deny } = schedule(map, grants, tasks);
  assert.equal(deny.length, 1);
  assert.equal(deny[0].task, 'T-blind');
  assert.equal(deny[0].reason, 'grant-not-visible');
  assert.deepEqual(deny[0].detail.unseenGrants, ['g1']);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].task, 'T-seeing');
  // multi-hop causal chain from grant event to dispatch event
  assert.deepEqual(plan[0].causalChain, ['e1', 'e5', 'e10']);
});

// Independent brute-force reference implementation for cross-checking.
function bruteForceAllows(map, grants, task) {
  const zone = map.zones.get(task.target.zone);
  if (zone.kind === 'normal') return true;
  // explicit ancestor walk of the dispatch event
  const ancestors = new Set();
  const stack = [...(task.dispatch.parents ?? [])];
  const allEvents = new Map();
  for (const g of grants) allEvents.set(g.event, g);
  while (stack.length) {
    const id = stack.pop();
    if (ancestors.has(id)) continue;
    ancestors.add(id);
    const ev = allEvents.get(id);
    if (ev) stack.push(...(ev.parents ?? []));
  }
  const t = task.dispatch.time;
  for (const g of grants) {
    if (g.op !== 'grant') continue;
    if (!ancestors.has(g.event)) continue;
    if (!(g.subject === '*' || (task.subject ?? '*') === '*' || g.subject === task.subject)) continue;
    const tgt = task.target;
    const covers =
      (g.level === 'zone' && g.zone === tgt.zone) ||
      (g.level === 'aisle' && g.zone === tgt.zone && g.aisle === tgt.aisle) ||
      (g.level === 'shelf' && g.zone === tgt.zone && g.aisle === tgt.aisle && g.shelf === tgt.shelf);
    if (!covers) continue;
    let effTo = g.to ?? Infinity;
    for (const r of grants) {
      if (r.op !== 'revoke') continue;
      if (!ancestors.has(r.event)) continue;
      if (r.subject === g.subject && r.level === g.level &&
          (r.zone ?? null) === (g.zone ?? null) &&
          (r.aisle ?? null) === (g.aisle ?? null) &&
          (r.shelf ?? null) === (g.shelf ?? null) &&
          r.time <= t) {
        effTo = Math.min(effTo, r.time);
      }
    }
    if (t >= (g.from ?? 0) && t < effTo) return true;
  }
  return false;
}

test('D: <=10 tasks, enumerate reachable zones and cross-check against brute force', () => {
  const map = makeMap();
  const grants = [
    { id: 'g1', op: 'grant', subject: '*', level: 'zone', zone: 'Z-RES', event: 'e1', lamport: 1, parents: [], time: 0, from: 0, to: 100 },
    { id: 'g2', op: 'grant', subject: 'agv-1', level: 'aisle', zone: 'Z-COLD', aisle: 'A-2', event: 'e2', lamport: 2, parents: ['e1'], time: 0, from: 0, to: 1000 },
    { id: 'g3', op: 'grant', subject: '*', level: 'shelf', zone: 'Z-CHG', aisle: 'A-3', shelf: 'S-30', event: 'e3', lamport: 3, parents: ['e2'], time: 0, from: 50, to: 200 },
    { id: 'r1', op: 'revoke', subject: '*', level: 'zone', zone: 'Z-RES', event: 'e4', lamport: 4, parents: ['e3'], time: 60 },
  ];
  const seen = ['e4'];
  const tasks = [
    { id: 'T01', target: { zone: 'Z-OPEN', aisle: 'A-0' }, dispatch: { event: 'd1', lamport: 11, parents: seen, time: 10 } },
    { id: 'T02', target: { zone: 'Z-RES', aisle: 'A-1' }, dispatch: { event: 'd2', lamport: 12, parents: seen, time: 10 } },
    { id: 'T03', target: { zone: 'Z-RES', aisle: 'A-1', shelf: 'S-11' }, dispatch: { event: 'd3', lamport: 13, parents: seen, time: 70 } },
    { id: 'T04', target: { zone: 'Z-RES', aisle: 'A-1', shelf: 'S-10' }, dispatch: { event: 'd4', lamport: 14, parents: seen, time: 50 } },
    { id: 'T05', subject: 'agv-1', target: { zone: 'Z-COLD', aisle: 'A-2' }, dispatch: { event: 'd5', lamport: 15, parents: seen, time: 100 } },
    { id: 'T06', subject: 'agv-2', target: { zone: 'Z-COLD', aisle: 'A-2' }, dispatch: { event: 'd6', lamport: 16, parents: seen, time: 100 } },
    { id: 'T07', target: { zone: 'Z-CHG', aisle: 'A-3', shelf: 'S-30' }, dispatch: { event: 'd7', lamport: 17, parents: seen, time: 100 } },
    { id: 'T08', target: { zone: 'Z-CHG', aisle: 'A-3', shelf: 'S-30' }, dispatch: { event: 'd8', lamport: 18, parents: seen, time: 300 } },
    { id: 'T09', target: { zone: 'Z-CHG', aisle: 'A-3' }, dispatch: { event: 'd9', lamport: 19, parents: seen, time: 100 } },
    { id: 'T10', subject: 'agv-1', target: { zone: 'Z-COLD', aisle: 'A-2', shelf: 'S-20' }, dispatch: { event: 'd10', lamport: 20, parents: seen, time: 100 } },
  ];
  assert.ok(tasks.length <= 10);
  const { plan, deny } = schedule(map, grants, tasks);
  const decision = new Map();
  for (const p of plan) decision.set(p.task, true);
  for (const d of deny) decision.set(d.task, false);
  assert.equal(decision.size, tasks.length);

  // 1) scheduler decision matches independent brute force for every task
  for (const task of tasks) {
    assert.equal(
      decision.get(task.id),
      bruteForceAllows(map, grants, task),
      `decision mismatch for ${task.id}`,
    );
  }

  // 2) reachable-zone enumeration matches brute-force expansion per task
  const events = buildEventIndex(normalizeEvents(grants, tasks));
  for (const task of tasks) {
    const reachable = enumerateReachableZones(map, grants, task, events).sort();
    const expected = [];
    for (const zone of map.zones.values()) {
      if (zone.kind === 'normal') {
        expected.push(zone.id);
        continue;
      }
      const targets = [{ zone: zone.id }];
      for (const aisle of zone.aisles) {
        targets.push({ zone: zone.id, aisle: aisle.id });
        for (const shelf of aisle.shelves) {
          targets.push({ zone: zone.id, aisle: aisle.id, shelf: shelf.id });
        }
      }
      if (targets.some((target) => bruteForceAllows(map, grants, { ...task, target }))) {
        expected.push(zone.id);
      }
    }
    assert.deepEqual(reachable, expected.sort(), `reachable mismatch for ${task.id}`);
    // allowed tasks must target a reachable zone
    if (decision.get(task.id)) {
      assert.ok(reachable.includes(task.target.zone), `${task.id} allowed but zone unreachable`);
    }
  }

  // spot-check expected outcomes
  assert.equal(decision.get('T02'), true); // zone-level grant inherits to aisle
  assert.equal(decision.get('T03'), false); // after revocation at t=60
  assert.equal(decision.get('T05'), true); // aisle-level grant, matching subject
  assert.equal(decision.get('T06'), false); // subject mismatch
  assert.equal(decision.get('T09'), false); // shelf grant does not cover whole aisle
  assert.equal(decision.get('T10'), true); // aisle grant inherits to shelf
});
