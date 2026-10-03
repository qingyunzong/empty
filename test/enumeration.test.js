import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from '../src/tree.js';
import { Scheduler } from '../src/scheduler.js';

// Independent brute-force reference implementation. It enumerates every
// subset of waiting orders and every permutation of lenders, then picks the
// best plan by: (1) max total units, (2) lexicographically smallest sorted
// scheduled order ids, (3) lexicographically smallest canonical borrow plan.

function brutePermutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  const out = [];
  for (let i = 0; i < arr.length; i += 1) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of brutePermutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

function bruteSimulate(subset, lenderPerm, orders, guarantee, capacity) {
  const used = new Map();
  const lent = new Map();
  const borrowed = new Map();
  let rootUsed = 0;
  const entries = [];
  const scheduled = [];
  let units = 0;
  for (const oid of subset) {
    const order = orders.find((o) => o.id === oid);
    const ownSlack = guarantee.get(order.tenant)
      - (lent.get(order.tenant) || 0)
      + (borrowed.get(order.tenant) || 0)
      - (used.get(order.tenant) || 0);
    const pathSlack = capacity - rootUsed;
    let need = 0;
    if (order.units > Math.min(ownSlack, pathSlack)) {
      if (pathSlack < order.units) return null;
      need = order.units - ownSlack;
    }
    if (need > 0) {
      for (const lender of lenderPerm) {
        if (need <= 0) break;
        if (lender === order.tenant) continue;
        const avail = guarantee.get(lender) - (lent.get(lender) || 0) - (used.get(lender) || 0);
        if (avail <= 0) continue;
        const take = Math.min(need, avail);
        entries.push([lender, oid, take]);
        lent.set(lender, (lent.get(lender) || 0) + take);
        borrowed.set(order.tenant, (borrowed.get(order.tenant) || 0) + take);
        need -= take;
      }
      if (need > 0) return null;
    }
    scheduled.push(oid);
    units += order.units;
    used.set(order.tenant, (used.get(order.tenant) || 0) + order.units);
    rootUsed += order.units;
  }
  return { scheduled, entries, units };
}

function cmpList(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function canonical(entries) {
  return entries.slice().sort((x, y) => cmpList([x[0], x[1]], [y[0], y[1]]) || x[2] - y[2]);
}

function bruteCompare(a, b) {
  if (a.units !== b.units) return b.units - a.units;
  const idCmp = cmpList(a.ids, b.ids);
  if (idCmp !== 0) return idCmp;
  const ea = canonical(a.entries);
  const eb = canonical(b.entries);
  const n = Math.min(ea.length, eb.length);
  for (let i = 0; i < n; i += 1) {
    const c = cmpList([ea[i][0], ea[i][1]], [eb[i][0], eb[i][1]]);
    if (c !== 0) return c;
    if (ea[i][2] !== eb[i][2]) return ea[i][2] - eb[i][2];
  }
  return ea.length - eb.length;
}

function bruteForce(tenants, orders) {
  let capacity = 0;
  const guarantee = new Map();
  for (const tenant of tenants) {
    if (tenant.parent === null) capacity = tenant.capacity;
    else guarantee.set(tenant.id, tenant.guarantee);
  }
  const lenderIds = [...guarantee.keys()].sort();
  const orderIds = orders.map((o) => o.id).sort();
  const perms = brutePermutations(lenderIds);
  let best = null;
  for (let mask = 1; mask < (1 << orderIds.length); mask += 1) {
    const subset = orderIds.filter((_, i) => mask & (1 << i));
    for (const perm of perms) {
      const res = bruteSimulate(subset, perm, orders, guarantee, capacity);
      if (!res) continue;
      const plan = { units: res.units, ids: res.scheduled.slice().sort(), entries: res.entries };
      if (!best || bruteCompare(plan, best) < 0) best = plan;
    }
  }
  return best || { units: 0, ids: [], entries: [] };
}

function schedulerPlan(tenants, orders) {
  const tree = buildTree(tenants);
  const scheduler = new Scheduler({ tree, orders, starveThreshold: 10 ** 9 });
  scheduler.schedulePass(0);
  const ids = scheduler.orders.filter((o) => o.active === o.units).map((o) => o.id).sort();
  const entries = scheduler.borrowEvents.map((e) => [e.lender, e.order, e.amount]);
  const units = scheduler.orders.reduce((sum, o) => sum + o.active, 0);
  return { units, ids, entries };
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test('scheduler matches exhaustive enumeration on small random scenarios', () => {
  const rand = lcg(20261004);
  const pick = (n) => Math.floor(rand() * n);
  let checked = 0;
  for (let s = 0; s < 40; s += 1) {
    const tenantCount = 2 + pick(3);
    const tenants = [{ id: 'root', parent: null, capacity: 0 }];
    let guaranteeSum = 0;
    for (let t = 0; t < tenantCount; t += 1) {
      const g = pick(7);
      guaranteeSum += g;
      tenants.push({ id: `T${t}`, parent: 'root', guarantee: g });
    }
    tenants[0].capacity = guaranteeSum + pick(3);

    const orderCount = 2 + pick(5);
    const orders = [];
    for (let o = 0; o < orderCount; o += 1) {
      orders.push({
        id: `o${o}`,
        tenant: `T${pick(tenantCount)}`,
        units: 1 + pick(6),
        priority: pick(4),
        submit: 0,
      });
    }

    const expected = bruteForce(tenants, orders);
    const actual = schedulerPlan(tenants, orders);

    assert.equal(actual.units, expected.units, `utilization mismatch in scenario ${s}`);
    assert.deepEqual(actual.ids, expected.ids, `scheduled id tie-break mismatch in scenario ${s}`);
    assert.deepEqual(
      canonical(actual.entries),
      canonical(expected.entries),
      `borrow plan tie-break mismatch in scenario ${s}`,
    );
    checked += 1;
  }
  assert.equal(checked, 40);
});

test('max quota utilization beats naive first-come scheduling', () => {
  const tenants = [
    { id: 'root', parent: null, capacity: 10 },
    { id: 'A', parent: 'root', guarantee: 10 },
  ];
  const orders = [
    { id: 'a1', tenant: 'A', units: 6, priority: 0, submit: 0 },
    { id: 'a2', tenant: 'A', units: 5, priority: 0, submit: 0 },
    { id: 'a3', tenant: 'A', units: 5, priority: 0, submit: 0 },
  ];
  const plan = schedulerPlan(tenants, orders);
  assert.equal(plan.units, 10);
  assert.deepEqual(plan.ids, ['a2', 'a3']);
});

test('lexicographic tie-break picks the smallest lender id', () => {
  const tenants = [
    { id: 'root', parent: null, capacity: 100 },
    { id: 'A', parent: 'root', guarantee: 5 },
    { id: 'B', parent: 'root', guarantee: 5 },
    { id: 'C', parent: 'root', guarantee: 0 },
  ];
  const orders = [{ id: 'c1', tenant: 'C', units: 3, priority: 0, submit: 0 }];
  const plan = schedulerPlan(tenants, orders);
  assert.equal(plan.units, 3);
  assert.deepEqual(plan.entries, [['A', 'c1', 3]]);

  const expected = bruteForce(tenants, orders);
  assert.deepEqual(canonical(expected.entries), [['A', 'c1', 3]]);
});
