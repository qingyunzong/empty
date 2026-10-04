import test from "node:test";
import assert from "node:assert/strict";
import {
  allocate,
  allocateByUnit,
  FairAllocator,
  formatReport,
  Fraction,
  type UserSpec,
} from "../src/index.js";

function toObject(map: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

test("fraction arithmetic stays exact", () => {
  const third = new Fraction(1, 3);
  assert.equal(third.mul(3).toString(), "1");
  assert.equal(third.add(new Fraction(1, 6)).toString(), "1/2");
  assert.equal(new Fraction(10, 3).floor(), 3n);
  assert.equal(new Fraction(-7, 2).floor(), -4n);
  assert.equal(new Fraction(4, 2).toString(), "2");
  assert.equal(new Fraction(2, 4).cmp(new Fraction(1, 2)), 0);
});

test("weighted split with remainder dealt by ascending ID", () => {
  // capacity 9, weights 1:1 -> floor 4 each, leftover 1 goes to u1 (smaller ID)
  const result = allocate(
    [
      { id: "u2", demand: 100, weight: 1 },
      { id: "u1", demand: 100, weight: 1 },
    ],
    9,
  );
  assert.deepEqual(toObject(result.allocation), { u1: 5, u2: 4 });
  assert.equal(result.rounds.length, 1);
  assert.equal(result.rounds[0].rate.toString(), "9/2");
  assert.equal(result.rounds[0].entries[0].idealShare.toString(), "9/2");
  assert.deepEqual(result.rounds[0].remainder, [{ id: "u1", units: 1 }]);
});

test("weights 2:1 split capacity 10 as 7:3 with remainder by ID", () => {
  const result = allocate(
    [
      { id: "heavy", demand: 100, weight: 2 },
      { id: "light", demand: 100, weight: 1 },
    ],
    10,
  );
  assert.deepEqual(toObject(result.allocation), { heavy: 7, light: 3 });
  assert.equal(result.rounds[0].rate.toString(), "10/3");
  const heavyEntry = result.rounds[0].entries.find((e) => e.id === "heavy");
  assert.equal(heavyEntry?.idealShare.toString(), "20/3");
});

test("demand saturation frees capacity for later rounds", () => {
  // u1 saturates on demand in round 1; u2 absorbs the freed capacity in round 2
  const result = allocate(
    [
      { id: "u1", demand: 1, weight: 1 },
      { id: "u2", demand: 100, weight: 1 },
    ],
    10,
  );
  assert.deepEqual(toObject(result.allocation), { u1: 1, u2: 9 });
  assert.equal(result.rounds.length, 2);
  assert.equal(result.rounds[0].entries.find((e) => e.id === "u1")?.saturated, true);
  assert.equal(result.rounds[0].entries.find((e) => e.id === "u1")?.saturatedBy, "demand");
  assert.deepEqual(
    result.saturationOrder.map((s) => s.id),
    ["u1"],
  );
});

test("per-user cap binds before demand", () => {
  const result = allocate(
    [
      { id: "capped", demand: 100, weight: 1, cap: 2 },
      { id: "free", demand: 100, weight: 1 },
    ],
    5,
  );
  assert.deepEqual(toObject(result.allocation), { capped: 2, free: 3 });
  const cappedEntry = result.rounds[0].entries.find((e) => e.id === "capped");
  assert.equal(cappedEntry?.saturatedBy, "cap");
});

test("capacity beyond total demand leaves everyone fully satisfied", () => {
  const result = allocate(
    [
      { id: "a", demand: 3, weight: 1 },
      { id: "b", demand: 4, weight: 2 },
    ],
    100,
  );
  assert.deepEqual(toObject(result.allocation), { a: 3, b: 4 });
  assert.equal(result.totalAllocated, 7);
});

test("zero capacity allocates nothing and records no rounds", () => {
  const result = allocate([{ id: "a", demand: 5, weight: 1 }], 0);
  assert.equal(result.totalAllocated, 0);
  assert.equal(result.rounds.length, 0);
});

test("demand revocation triggers full re-allocation", () => {
  const allocator = new FairAllocator(10);
  allocator
    .addUser({ id: "a", demand: 8, weight: 1 })
    .addUser({ id: "b", demand: 8, weight: 1 })
    .addUser({ id: "c", demand: 8, weight: 2 });

  const before = allocator.allocate();
  // round 1: rate 10/4 = 5/2 -> floors 2/2/5, remainder 1 to smallest ID "a"
  assert.deepEqual(toObject(before.allocation), { a: 3, b: 2, c: 5 });

  const after = allocator.revokeDemand("c");
  assert.deepEqual(toObject(after.allocation), { a: 5, b: 5, c: 0 });
  assert.equal(after.totalAllocated, 10);
  // Re-allocation equals a fresh run without the revoked demand.
  const fresh = allocate(
    [
      { id: "a", demand: 8, weight: 1 },
      { id: "b", demand: 8, weight: 1 },
      { id: "c", demand: 0, weight: 2 },
    ],
    10,
  );
  assert.deepEqual(toObject(after.allocation), toObject(fresh.allocation));
});

test("report exposes saturated rounds and fractional evidence", () => {
  const result = allocate(
    [
      { id: "u1", demand: 1, weight: 1 },
      { id: "u2", demand: 100, weight: 1 },
    ],
    10,
  );
  const report = formatReport(result);
  assert.match(report, /round 1: capacity=10 weightSum=2 rate=5/);
  assert.match(report, /user u1: ideal=5 granted=1 residual=1 SATURATED\(demand\)/);
  assert.match(report, /round 2: capacity=4 weightSum=1 rate=4/);
  assert.match(report, /saturation order: u1@r1/);
});

// --- Cross-check against the per-unit reference model -----------------------

function randomUsers(rng: () => number, count: number): UserSpec[] {
  const users: UserSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `u${i}`;
    const demand = 1 + Math.floor(rng() * 12);
    const weight = 1 + Math.floor(rng() * 4);
    const spec: UserSpec = { id, demand, weight };
    if (rng() < 0.3) spec.cap = 1 + Math.floor(rng() * demand);
    users.push(spec);
  }
  return users;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("batch allocator cross-checked against per-unit model on randomized small capacities", () => {
  const rng = mulberry32(20261005);
  let maxPerUserDiff = 0;
  let agreedTrials = 0;
  const trials = 500;
  for (let trial = 0; trial < trials; trial += 1) {
    const userCount = 2 + Math.floor(rng() * 4);
    const users = randomUsers(rng, userCount);
    const capacity = Math.floor(rng() * 30);
    const batch = allocate(users, capacity);
    const unit = allocateByUnit(users, capacity);
    // Both models are non-wasteful: identical total allocation.
    const bound = Math.min(
      capacity,
      users.reduce((s, u) => s + Math.min(u.demand, u.cap ?? u.demand), 0),
    );
    assert.equal(batch.totalAllocated, bound);
    assert.equal(
      [...unit.values()].reduce((s, v) => s + v, 0),
      bound,
    );
    // Both respect per-user demand and cap.
    let agrees = true;
    for (const u of users) {
      const limit = Math.min(u.demand, u.cap ?? u.demand);
      const b = batch.allocation.get(u.id) ?? 0;
      const v = unit.get(u.id) ?? 0;
      assert.ok(b >= 0 && b <= limit, `batch out of limits for ${u.id}`);
      assert.ok(v >= 0 && v <= limit, `unit model out of limits for ${u.id}`);
      const diff = Math.abs(b - v);
      if (diff > maxPerUserDiff) maxPerUserDiff = diff;
      if (diff !== 0) agrees = false;
    }
    if (agrees) agreedTrials += 1;
  }
  // The two integer rounding policies (floor+remainder-by-ID vs per-unit
  // greedy) coincide most of the time; observed per-user gap stays <= 1 on
  // this seeded corpus (larger gaps need >= 4 active users and caps).
  console.log(
    `cross-check: ${agreedTrials}/${trials} trials identical, max per-user diff ${maxPerUserDiff}`,
  );
  assert.ok(agreedTrials > trials / 2, "models should agree on a majority of cases");
  assert.ok(maxPerUserDiff <= 2, `per-user diff too large: ${maxPerUserDiff}`);
});

test("re-allocation after revocation stays consistent with per-unit model", () => {
  const rng = mulberry32(7);
  for (let trial = 0; trial < 200; trial += 1) {
    const users = randomUsers(rng, 3);
    const capacity = 1 + Math.floor(rng() * 20);
    const allocator = new FairAllocator(capacity);
    for (const u of users) allocator.addUser(u);
    const victim = users[Math.floor(rng() * users.length)].id;
    const after = allocator.revokeDemand(victim);
    // Revoked user gets nothing; freed capacity is fully redistributed.
    assert.equal(after.allocation.get(victim), 0);
    const remainingUsers = users.filter((u) => u.id !== victim);
    const bound = Math.min(
      capacity,
      remainingUsers.reduce((s, u) => s + Math.min(u.demand, u.cap ?? u.demand), 0),
    );
    assert.equal(after.totalAllocated, bound);
    // The per-unit reference model agrees on the total and per-user limits.
    const unit = allocateByUnit(
      users.map((u) => (u.id === victim ? { ...u, demand: 0 } : u)),
      capacity,
    );
    assert.equal([...unit.values()].reduce((s, v) => s + v, 0), bound);
    for (const u of users) {
      const limit = u.id === victim ? 0 : Math.min(u.demand, u.cap ?? u.demand);
      const b = after.allocation.get(u.id) ?? 0;
      const v = unit.get(u.id) ?? 0;
      assert.ok(b >= 0 && b <= limit, `batch out of limits for ${u.id}`);
      assert.ok(v >= 0 && v <= limit, `unit model out of limits for ${u.id}`);
      assert.ok(
        Math.abs(b - v) <= 2,
        `revocation diff too large at trial ${trial} for ${u.id}: batch=${b} unit=${v}`,
      );
    }
  }
});
