import test from 'node:test';
import assert from 'node:assert/strict';
import { Planner } from '../src/planner.js';
import { runCli } from '../src/cli.js';

function buildBasic() {
  const p = new Planner();
  for (const [id, demand] of [['o1', 5], ['o2', 5], ['o3', 5]]) {
    assert.equal(p.execute({ cmd: 'add_order', id, demand }).status, 'OK');
  }
  assert.equal(p.execute({ cmd: 'add_slot', id: 's1', machine: 'M1', start: 0, end: 10, capacity: 8 }).status, 'OK');
  assert.equal(p.execute({ cmd: 'add_slot', id: 's2', machine: 'M2', start: 0, end: 10, capacity: 8 }).status, 'OK');
  for (const o of ['o1', 'o2', 'o3']) {
    for (const s of ['s1', 's2']) {
      assert.equal(p.execute({ cmd: 'link', order: o, slot: s }).status, 'OK');
    }
  }
  return p;
}

test('1. three orders, two machines: basic feasible flow with certificate', () => {
  const p = buildBasic();
  const r = p.execute({ cmd: 'flow' });
  assert.equal(r.status, 'OK');
  assert.equal(r.value, 15);
  assert.equal(r.bottleneck_cut.value, 15);
  // capacity is abundant, so the bottleneck is order demand (cut on source edges)
  assert.deepEqual(r.bottleneck_cut.orders, []);
  assert.deepEqual(r.bottleneck_cut.slots, []);
  // assignments sorted by order id, then slot start time
  const keys = r.assignments.map((a) => `${a.order}@${a.start}`);
  assert.deepEqual(keys, [...keys].sort());
  const perOrder = new Map();
  for (const a of r.assignments) perOrder.set(a.order, (perOrder.get(a.order) ?? 0) + a.qty);
  for (const o of ['o1', 'o2', 'o3']) assert.equal(perOrder.get(o), 5);
  const v = p.execute({ cmd: 'verify' });
  assert.equal(v.status, 'OK');
  assert.equal(v.valid, true);
  assert.deepEqual(v.checks, { conservation: true, capacity: true, time_window: true, cut_equals_flow: true });
});

test('2. slowdown drops value and migrates the bottleneck to machine capacity', () => {
  const p = new Planner();
  p.execute({ cmd: 'add_order', id: 'o1', demand: 10 });
  p.execute({ cmd: 'add_order', id: 'o2', demand: 10 });
  p.execute({ cmd: 'add_slot', id: 's1', machine: 'M1', start: 0, end: 10, capacity: 10 });
  p.execute({ cmd: 'add_slot', id: 's2', machine: 'M2', start: 0, end: 10, capacity: 10 });
  for (const o of ['o1', 'o2']) for (const s of ['s1', 's2']) p.execute({ cmd: 'link', order: o, slot: s });

  const before = p.execute({ cmd: 'flow' });
  assert.equal(before.value, 20);
  assert.deepEqual(before.bottleneck_cut.slots, []); // demand-bound

  assert.equal(p.execute({ cmd: 'slow', machine: 'M1', factor: 0.5 }).status, 'OK');
  const after = p.execute({ cmd: 'flow' });
  assert.equal(after.value, 15); // 5 (slowed M1) + 10 (M2)
  assert.ok(after.bottleneck_cut.slots.length > 0, 'bottleneck migrated to machine capacity');
  assert.equal(after.bottleneck_cut.value, 15);
  assert.equal(p.execute({ cmd: 'verify' }).valid, true);

  // undoing the slowdown restores the original value
  assert.equal(p.execute({ cmd: 'undo' }).status, 'OK');
  assert.equal(p.execute({ cmd: 'flow' }).value, 20);
});

test('3. rush order then undo restores the original value; commit protects the plan', () => {
  const p = new Planner();
  p.execute({ cmd: 'add_order', id: 'o1', demand: 6 });
  p.execute({ cmd: 'add_slot', id: 's1', machine: 'M1', start: 0, end: 10, capacity: 10 });
  p.execute({ cmd: 'link', order: 'o1', slot: 's1' });
  assert.equal(p.execute({ cmd: 'commit' }).status, 'OK');
  assert.equal(p.execute({ cmd: 'flow' }).value, 6);

  // rush order comes in
  p.execute({ cmd: 'add_order', id: 'o2', demand: 6 });
  p.execute({ cmd: 'link', order: 'o2', slot: 's1' });
  assert.equal(p.execute({ cmd: 'flow' }).value, 10);

  // undo both corrections -> original value restored
  assert.equal(p.execute({ cmd: 'undo' }).status, 'OK');
  assert.equal(p.execute({ cmd: 'undo' }).status, 'OK');
  assert.equal(p.execute({ cmd: 'flow' }).value, 6);

  // committed plan is not lost: nothing left to undo
  assert.equal(p.execute({ cmd: 'undo' }).status, 'UNDO_EMPTY');
  assert.equal(p.execute({ cmd: 'flow' }).value, 6);
  assert.equal(p.execute({ cmd: 'verify' }).valid, true);
});

function bruteForce(orders, slots, links) {
  let best = 0;
  const orderUsed = new Array(orders.length).fill(0);
  const slotUsed = new Array(slots.length).fill(0);
  const dfs = (i, total) => {
    if (i === links.length) {
      best = Math.max(best, total);
      return;
    }
    const l = links[i];
    const maxF = Math.min(l.cap, orders[l.o] - orderUsed[l.o], slots[l.s] - slotUsed[l.s]);
    for (let f = 0; f <= maxF; f++) {
      orderUsed[l.o] += f;
      slotUsed[l.s] += f;
      dfs(i + 1, total + f);
      orderUsed[l.o] -= f;
      slotUsed[l.s] -= f;
    }
  };
  dfs(0, 0);
  return best;
}

test('4. max flow matches brute-force machine-assignment enumeration (n <= 8)', () => {
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let instance = 0; instance < 25; instance++) {
    const nOrders = 2 + Math.floor(rand() * 2);
    const nSlots = 2 + Math.floor(rand() * 2);
    const p = new Planner();
    const demands = [];
    for (let i = 0; i < nOrders; i++) {
      const d = 1 + Math.floor(rand() * 3);
      demands.push(d);
      p.execute({ cmd: 'add_order', id: `o${i}`, demand: d, release: 0, due: 1000 });
    }
    const caps = [];
    for (let j = 0; j < nSlots; j++) {
      const cap = 1 + Math.floor(rand() * 3);
      caps.push(cap);
      p.execute({ cmd: 'add_slot', id: `s${j}`, machine: `M${j % 2}`, start: j * 10, end: j * 10 + 10, capacity: cap });
    }
    const links = [];
    for (let i = 0; i < nOrders && links.length < 8; i++) {
      for (let j = 0; j < nSlots && links.length < 8; j++) {
        if (rand() < 0.65) {
          const cap = 1 + Math.floor(rand() * 3);
          links.push({ o: i, s: j, cap });
          p.execute({ cmd: 'link', order: `o${i}`, slot: `s${j}`, capacity: cap });
        }
      }
    }
    const got = p.execute({ cmd: 'flow' }).value;
    const want = bruteForce(demands, caps, links);
    assert.equal(got, want, `instance ${instance}: flow ${got} != brute force ${want}`);
    assert.equal(p.execute({ cmd: 'verify' }).valid, true, `instance ${instance}: verify failed`);
  }
});

test('5. overlapping windows, negative capacity and repeated commit are rejected', () => {
  const p = new Planner();
  // repeated commit
  assert.equal(p.execute({ cmd: 'commit' }).status, 'CONFLICT');
  assert.equal(p.execute({ cmd: 'add_order', id: 'o1', demand: 5, release: 5, due: 20 }).status, 'OK');
  assert.equal(p.execute({ cmd: 'commit' }).status, 'OK');
  assert.equal(p.execute({ cmd: 'commit' }).status, 'CONFLICT');
  // undo after commit must not touch the confirmed plan
  assert.equal(p.execute({ cmd: 'undo' }).status, 'UNDO_EMPTY');
  assert.ok(p.orders.has('o1'));

  // negative capacities
  assert.equal(p.execute({ cmd: 'add_slot', id: 's1', machine: 'M1', start: 0, end: 10, capacity: -1 }).status, 'INVALID_INPUT');
  assert.equal(p.execute({ cmd: 'add_order', id: 'o2', demand: -3 }).status, 'INVALID_INPUT');
  assert.equal(p.execute({ cmd: 'add_slot', id: 's1', machine: 'M1', start: 0, end: 10, capacity: 4 }).status, 'OK');
  assert.equal(p.execute({ cmd: 'link', order: 'o1', slot: 's1', capacity: -2 }).status, 'INVALID_INPUT');

  // overlapping time windows on the same machine
  assert.equal(p.execute({ cmd: 'add_slot', id: 's2', machine: 'M1', start: 5, end: 15, capacity: 4 }).status, 'INVALID_INPUT');
  assert.equal(p.execute({ cmd: 'add_slot', id: 's2', machine: 'M2', start: 5, end: 15, capacity: 4 }).status, 'OK');
  // touching windows are fine
  assert.equal(p.execute({ cmd: 'add_slot', id: 's3', machine: 'M1', start: 10, end: 20, capacity: 4 }).status, 'OK');

  // link outside the order time window
  assert.equal(p.execute({ cmd: 'link', order: 'o1', slot: 's1' }).status, 'INVALID_INPUT'); // [0,10) vs release 5
  assert.equal(p.execute({ cmd: 'link', order: 'o1', slot: 's3' }).status, 'OK'); // [10,20) within [5,20]

  // duplicates and unknown references
  assert.equal(p.execute({ cmd: 'add_order', id: 'o1', demand: 1 }).status, 'CONFLICT');
  assert.equal(p.execute({ cmd: 'link', order: 'o1', slot: 'nope' }).status, 'INVALID_INPUT');
  assert.equal(p.execute({ cmd: 'cancel', id: 'nope' }).status, 'INVALID_INPUT');
  assert.equal(p.execute({ cmd: 'slow', machine: 'M1', factor: 0 }).status, 'INVALID_INPUT');
  assert.equal(p.execute({ cmd: 'explode' }).status, 'INVALID_INPUT');
});

test('cancel and slow are undoable corrections', () => {
  const p = buildBasic();
  assert.equal(p.execute({ cmd: 'flow' }).value, 15);
  assert.equal(p.execute({ cmd: 'cancel', id: 'o1' }).status, 'OK');
  assert.equal(p.execute({ cmd: 'flow' }).value, 10);
  assert.equal(p.execute({ cmd: 'undo' }).status, 'OK'); // restore o1 and its links
  assert.equal(p.execute({ cmd: 'flow' }).value, 15);
  assert.equal(p.execute({ cmd: 'slow', machine: 'M1', factor: 0.5 }).status, 'OK');
  assert.equal(p.execute({ cmd: 'flow' }).value, 12);
  assert.equal(p.execute({ cmd: 'undo' }).status, 'OK');
  assert.equal(p.execute({ cmd: 'flow' }).value, 15);
});

test('CLI processes JSONL and reports per-command results', () => {
  const script = [
    { cmd: 'add_order', id: 'o1', demand: 6 },
    { cmd: 'add_slot', id: 's1', machine: 'M1', start: 0, end: 10, capacity: 10 },
    { cmd: 'link', order: 'o1', slot: 's1' },
    { cmd: 'commit' },
    { cmd: 'commit' },
    { cmd: 'add_order', id: 'o2', demand: 6 },
    { cmd: 'link', order: 'o2', slot: 's1' },
    { cmd: 'flow' },
    { cmd: 'verify' },
    { cmd: 'undo' },
    { cmd: 'undo' },
    { cmd: 'undo' },
    { cmd: 'flow' },
    { cmd: 'add_slot', id: 's2', machine: 'M1', start: 2, end: 8, capacity: 3 },
    'not json',
  ];
  const input = script.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  const out = runCli(input).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(out.length, 15);
  assert.deepEqual(out.slice(0, 4).map((r) => r.status), ['OK', 'OK', 'OK', 'OK']);
  assert.equal(out[4].status, 'CONFLICT'); // repeated commit
  assert.equal(out[7].status, 'OK');
  assert.equal(out[7].value, 10); // rush order fills the slot
  assert.deepEqual(out[7].assignments.map((a) => a.order), ['o1', 'o2']);
  assert.equal(out[8].valid, true);
  assert.equal(out[9].status, 'OK'); // undo link
  assert.equal(out[10].status, 'OK'); // undo rush order
  assert.equal(out[11].status, 'UNDO_EMPTY'); // committed plan protected
  assert.equal(out[12].value, 6); // original value restored
  assert.equal(out[13].status, 'INVALID_INPUT'); // overlapping window
  assert.equal(out[14].status, 'INVALID_INPUT'); // malformed JSON
});
