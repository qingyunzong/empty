import { test } from "node:test";
import assert from "node:assert/strict";
import { solve, simulate, compareSequences, minimalConflictSet } from "../src/schedule.js";

// ---------- helpers ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInstance(rand, { n, machines, molds, persons, tight = false }) {
  const inst = { machines: [], molds: {}, setups: {}, orders: {}, orderIds: [] };
  for (let i = 1; i <= machines; i++) inst.machines.push(`M${i}`);
  for (let i = 1; i <= molds; i++) inst.molds[`F${i}`] = { id: `F${i}`, cycle: 1 + Math.floor(rand() * 3) };
  for (const a of Object.keys(inst.molds))
    for (const b of Object.keys(inst.molds))
      if (a !== b) (inst.setups[a] ??= {})[b] = Math.floor(rand() * 4);
  let total = 0;
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const id = `O${String(i).padStart(2, "0")}`;
    const mold = `F${1 + Math.floor(rand() * molds)}`;
    const qty = 1 + Math.floor(rand() * 4);
    const proc = qty * inst.molds[mold].cycle;
    total += proc;
    ids.push(id);
    inst.orders[id] = {
      id, mold, qty,
      due: 0, // filled below
      person: `P${1 + Math.floor(rand() * persons)}`,
      committed: false,
      proc,
    };
  }
  const horizon = tight ? Math.ceil(total / machines) : total * 2;
  for (const id of ids) inst.orders[id].due = horizon + Math.floor(rand() * total);
  inst.orderIds = ids.sort();
  return inst;
}

// Independent brute force: insert each order at every position of every
// machine's list -- generates each ordered partition exactly once.
function bruteForce(instance, orderIds) {
  const ids = [...orderIds].sort();
  const seqs = Object.fromEntries(instance.machines.map((m) => [m, []]));
  let best = null;
  function rec(i) {
    if (i === ids.length) {
      const sim = simulate(instance, seqs);
      if (!sim.plan.every((op) => op.end <= instance.orders[op.order].due)) return;
      const cand = {
        makespan: sim.makespan,
        changes: sim.changes,
        seqs: JSON.parse(JSON.stringify(seqs)),
      };
      if (
        !best ||
        cand.makespan < best.makespan ||
        (cand.makespan === best.makespan &&
          (cand.changes < best.changes ||
            (cand.changes === best.changes &&
              compareSequences(cand.seqs, best.seqs, instance.machines) < 0)))
      ) {
        best = cand;
      }
      return;
    }
    const oid = ids[i];
    for (const m of instance.machines) {
      for (let pos = 0; pos <= seqs[m].length; pos++) {
        seqs[m].splice(pos, 0, oid);
        rec(i + 1);
        seqs[m].splice(pos, 1);
      }
    }
  }
  rec(0);
  return best;
}

function validateSchedule(instance, res, orderIds) {
  assert.ok(res.plan.length === orderIds.length, "all orders scheduled");
  // every order scheduled exactly once
  assert.deepEqual([...res.plan.map((p) => p.order)].sort(), [...orderIds].sort());
  // machine non-overlap per machine sequence
  for (const m of instance.machines) {
    const ops = res.plan.filter((p) => p.machine === m).sort((a, b) => a.start - b.start);
    for (let i = 1; i < ops.length; i++) assert.ok(ops[i].start >= ops[i - 1].end, "machine overlap");
  }
  // mold non-overlap
  const byMold = {};
  for (const p of res.plan) (byMold[instance.orders[p.order].mold] ??= []).push(p);
  for (const ops of Object.values(byMold)) {
    ops.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ops.length; i++) assert.ok(ops[i].start >= ops[i - 1].end, "mold overlap");
  }
  // person non-overlap
  const byPerson = {};
  for (const p of res.plan) (byPerson[instance.orders[p.order].person] ??= []).push(p);
  for (const ops of Object.values(byPerson)) {
    ops.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ops.length; i++) assert.ok(ops[i].start >= ops[i - 1].end, "person overlap");
  }
  // due dates
  for (const p of res.plan) assert.ok(p.end <= instance.orders[p.order].due, "due violated");
}

// ---------- acceptance 1: exact match with brute-force enumeration ----------

test("solve matches brute-force enumeration on random instances (n<=8)", () => {
  for (let seed = 1; seed <= 12; seed++) {
    const rand = mulberry32(seed);
    const n = 2 + Math.floor(rand() * 7); // 2..8
    const machines = 1 + Math.floor(rand() * 2);
    const inst = randomInstance(rand, { n, machines, molds: 2 + Math.floor(rand() * 2), persons: 1 + Math.floor(rand() * 2) });
    const got = solve(inst, inst.orderIds);
    const want = bruteForce(inst, inst.orderIds);
    if (!want) {
      assert.equal(got.status, "infeasible", `seed=${seed} feasibility mismatch`);
      continue;
    }
    assert.equal(got.status, "optimal", `seed=${seed}`);
    assert.equal(got.makespan, want.makespan, `seed=${seed} makespan`);
    assert.equal(got.changes, want.changes, `seed=${seed} changes`);
    assert.deepEqual(got.sequences, want.seqs, `seed=${seed} sequences (lex tiebreak)`);
    validateSchedule(inst, got, inst.orderIds);
  }
});

test("solve matches brute force on tight due dates (infeasible cases)", () => {
  for (let seed = 100; seed < 106; seed++) {
    const rand = mulberry32(seed);
    const inst = randomInstance(rand, { n: 6, machines: 1, molds: 2, persons: 2, tight: true });
    for (const id of inst.orderIds) inst.orders[id].due = Math.floor(rand() * 12);
    const got = solve(inst, inst.orderIds);
    const want = bruteForce(inst, inst.orderIds);
    assert.equal(got.status === "infeasible", want === null, `seed=${seed} feasibility`);
    if (want) {
      assert.equal(got.makespan, want.makespan);
      assert.deepEqual(got.sequences, want.seqs);
    }
  }
});

// Subset-DP reference (single machine, no due dates) -- exact brute force
// for larger n where naive enumeration is impossible.
function dpReference(instance, ids) {
  const n = ids.length;
  const FULL = (1 << n) - 1;
  const proc = ids.map((id) => instance.orders[id].proc);
  const mold = ids.map((id) => instance.orders[id].mold);
  const setup = (a, b) => (a === b ? 0 : instance.setups[a]?.[b] ?? 0);
  // dp[mask] = Map(lastIdx -> pareto list of [time, changes])
  const dp = new Array(1 << n);
  dp[0] = new Map([[-1, [[0, 0]]]]);
  const addPareto = (list, t, c) => {
    for (const [et, ec] of list) if (et <= t && ec <= c) return;
    for (let i = list.length - 1; i >= 0; i--) if (list[i][0] >= t && list[i][1] >= c) list.splice(i, 1);
    list.push([t, c]);
  };
  for (let mask = 0; mask <= FULL; mask++) {
    const entry = dp[mask];
    if (!entry) continue;
    for (const [last, pairs] of entry) {
      for (let j = 0; j < n; j++) {
        if (mask & (1 << j)) continue;
        const s = last === -1 ? 0 : setup(mold[last], mold[j]);
        const dc = last !== -1 && mold[last] !== mold[j] ? 1 : 0;
        const nm = mask | (1 << j);
        dp[nm] ??= new Map();
        const lst = dp[nm].get(j) ?? [];
        for (const [t, c] of pairs) addPareto(lst, t + s + proc[j], c + dc);
        dp[nm].set(j, lst);
      }
    }
  }
  // optimal objective
  let best = null;
  for (const [last, pairs] of dp[FULL]) {
    for (const [t, c] of pairs) {
      if (!best || t < best[0] || (t === best[0] && c < best[1])) best = [t, c];
    }
  }
  // backward "good" sets: states that can still reach the optimum
  const good = new Array(1 << n);
  good[FULL] = new Map();
  for (const [last, pairs] of dp[FULL]) {
    const keep = pairs.filter(([t, c]) => t === best[0] && c === best[1]);
    if (keep.length) good[FULL].set(last, keep);
  }
  for (let mask = FULL - 1; mask >= 0; mask--) {
    good[mask] = new Map();
    const entry = dp[mask];
    if (!entry) continue;
    for (const [last, pairs] of entry) {
      for (const [t, c] of pairs) {
        let ok = false;
        for (let j = 0; j < n && !ok; j++) {
          if (mask & (1 << j)) continue;
          const s = last === -1 ? 0 : setup(mold[last], mold[j]);
          const dc = last !== -1 && mold[last] !== mold[j] ? 1 : 0;
          const nt = t + s + proc[j];
          const nc = c + dc;
          const target = good[mask | (1 << j)]?.get(j);
          if (target && target.some(([et, ec]) => et === nt && ec === nc)) ok = true;
        }
        if (ok) {
          const lst = good[mask].get(last) ?? [];
          lst.push([t, c]);
          good[mask].set(last, lst);
        }
      }
    }
  }
  // lexicographically smallest sequence through good states
  const seq = [];
  let mask = 0;
  let last = -1;
  let t = 0;
  let c = 0;
  const order = [...ids].sort();
  while (mask !== FULL) {
    for (const id of order) {
      const j = ids.indexOf(id);
      if (mask & (1 << j)) continue;
      const s = last === -1 ? 0 : setup(mold[last], mold[j]);
      const dc = last !== -1 && mold[last] !== mold[j] ? 1 : 0;
      const nt = t + s + proc[j];
      const nc = c + dc;
      const target = good[mask | (1 << j)]?.get(j);
      if (target && target.some(([et, ec]) => et === nt && ec === nc)) {
        seq.push(id);
        mask |= 1 << j;
        last = j;
        t = nt;
        c = nc;
        break;
      }
    }
  }
  return { makespan: best[0], changes: best[1], sequence: seq };
}

test("16 orders, single machine: solve matches subset-DP brute force", () => {
  const rand = mulberry32(42);
  const inst = randomInstance(rand, { n: 16, machines: 1, molds: 3, persons: 3 });
  for (const id of inst.orderIds) inst.orders[id].due = Number.MAX_SAFE_INTEGER;
  const got = solve(inst, inst.orderIds);
  const want = dpReference(inst, inst.orderIds);
  assert.equal(got.status, "optimal");
  assert.equal(got.makespan, want.makespan);
  assert.equal(got.changes, want.changes);
  assert.deepEqual(got.sequences[inst.machines[0]], want.sequence);
});

test("20 orders, single machine single mold: analytic optimum", () => {
  const inst = { machines: ["M1"], molds: { F1: { id: "F1", cycle: 2 } }, setups: {}, orders: {}, orderIds: [] };
  let total = 0;
  for (let i = 1; i <= 20; i++) {
    const id = `O${String(i).padStart(2, "0")}`;
    const proc = 2 * (1 + (i % 4));
    total += proc;
    inst.orders[id] = { id, mold: "F1", qty: proc / 2, due: 10000, person: "P1", committed: false, proc };
    inst.orderIds.push(id);
  }
  const got = solve(inst, inst.orderIds);
  assert.equal(got.status, "optimal");
  assert.equal(got.makespan, total); // no setups possible with one mold
  assert.equal(got.changes, 0);
  assert.deepEqual(got.sequences.M1, [...inst.orderIds].sort()); // lex smallest
});

test("20 orders, two machines: valid, deterministic, dues met", () => {
  const rand = mulberry32(7);
  const inst = randomInstance(rand, { n: 20, machines: 2, molds: 3, persons: 2 });
  const a = solve(inst, inst.orderIds, { nodeCap: 150000 });
  const b = solve(inst, inst.orderIds, { nodeCap: 150000 });
  assert.ok(a.status === "optimal" || a.status === "fallback");
  assert.deepEqual(a, b); // deterministic
  validateSchedule(inst, a, inst.orderIds);
});

test("unknown setup entries default to 0, never infeasible", () => {
  const inst = {
    machines: ["M1"],
    molds: { F1: { id: "F1", cycle: 2 }, F2: { id: "F2", cycle: 1 } },
    setups: {}, // nothing known
    orders: {
      A: { id: "A", mold: "F1", qty: 2, due: 100, person: "P1", proc: 4 },
      B: { id: "B", mold: "F2", qty: 3, due: 100, person: "P1", proc: 3 },
    },
    orderIds: ["A", "B"],
  };
  const res = solve(inst, ["A", "B"]);
  assert.equal(res.status, "optimal");
  assert.equal(res.makespan, 7);
});

test("minimal conflict set is irreducible", () => {
  const inst = {
    machines: ["M1"],
    molds: { F1: { id: "F1", cycle: 1 } },
    setups: {},
    orders: {
      A: { id: "A", mold: "F1", qty: 10, due: 15, person: "P1", proc: 10 },
      B: { id: "B", mold: "F1", qty: 10, due: 15, person: "P1", proc: 10 },
      C: { id: "C", mold: "F1", qty: 1, due: 100, person: "P1", proc: 1 },
    },
    orderIds: ["A", "B", "C"],
  };
  assert.equal(solve(inst, inst.orderIds).status, "infeasible");
  const conflicts = minimalConflictSet(inst, inst.orderIds);
  assert.deepEqual(conflicts, ["A", "B"]); // C is not part of any conflict
  // irreducible: removing either one makes it feasible
  assert.notEqual(solve(inst, ["A"]).status, "infeasible");
  assert.notEqual(solve(inst, ["B"]).status, "infeasible");
});

test("resource conflicts are never silently overlapped", () => {
  // One mold, one person, two machines: orders must serialize on mold+person.
  const inst = {
    machines: ["M1", "M2"],
    molds: { F1: { id: "F1", cycle: 5 } },
    setups: {},
    orders: {
      A: { id: "A", mold: "F1", qty: 1, due: 100, person: "P1", proc: 5 },
      B: { id: "B", mold: "F1", qty: 1, due: 100, person: "P1", proc: 5 },
    },
    orderIds: ["A", "B"],
  };
  const res = solve(inst, ["A", "B"]);
  assert.equal(res.makespan, 10); // cannot run in parallel despite 2 machines
  validateSchedule(inst, res, ["A", "B"]);
});
