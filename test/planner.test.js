import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  solve,
  plan,
  buildCertificate,
  verifyCertificate,
  hashObject,
  ERR_WINDOW,
} from '../src/planner.js';
import { runCli } from '../src/cli.js';

// ---------- independent branch-and-bound reference ----------
// Written separately from src/planner.js: slot-based kit checks, own recursion.
function referenceBnB(instance) {
  const { orders, techs, kits } = instance;

  function kitsOkSlot(parts) {
    const pool = kits.map((k) => ({ compatible: k.compatible, left: k.qty }));
    const units = [...parts].sort(
      (a, b) =>
        pool.filter((k) => k.compatible.includes(a)).length -
        pool.filter((k) => k.compatible.includes(b)).length
    );
    function bt(i) {
      if (i === units.length) return true;
      for (const k of pool) {
        if (k.left > 0 && k.compatible.includes(units[i])) {
          k.left--;
          if (bt(i + 1)) return true;
          k.left++;
        }
      }
      return false;
    }
    return bt(0);
  }

  const placed = []; // {tech, start, end, parts, skill, order}
  let best = null;
  let count = 0;
  const sols = [];

  const vecOf = (completed, overtime, switches) => ({ completed, overtime, switches });
  const better = (a, b) =>
    a.completed !== b.completed ? a.completed > b.completed
    : a.overtime !== b.overtime ? a.overtime < b.overtime
    : a.switches < b.switches;

  function switchesOf() {
    let sw = 0;
    for (let t = 0; t < techs.length; t++) {
      const list = placed.filter((p) => p.tech === t).sort((a, b) => a.start - b.start);
      for (let i = 1; i < list.length; i++) if (list[i].skill !== list[i - 1].skill) sw++;
    }
    return sw;
  }

  function dfs(i, completed, overtime) {
    if (best && completed + (orders.length - i) < best.completed) return;
    if (i === orders.length) {
      const v = vecOf(completed, overtime, switchesOf());
      if (!best || better(v, best)) { best = v; count = 1; sols.length = 0; sols.push(snapshot()); }
      else if (v.completed === best.completed && v.overtime === best.overtime && v.switches === best.switches) {
        count++; sols.push(snapshot());
      }
      return;
    }
    const o = orders[i];
    for (let t = 0; t < techs.length; t++) {
      const tech = techs[t];
      if (!tech.skills.includes(o.skill)) continue;
      for (const [ss, se] of tech.shifts) {
        for (let s = Math.max(o.window[0], ss); s <= Math.min(o.window[1] - o.duration, se - 1); s++) {
          const e = s + o.duration;
          if (placed.some((p) => p.tech === t && p.start < e && s < p.end)) continue;
          let ok = true;
          for (let slot = s; slot < e && ok; slot++) {
            const demand = [...o.parts];
            for (const p of placed) if (p.start <= slot && slot < p.end) demand.push(...p.parts);
            if (!kitsOkSlot(demand)) ok = false;
          }
          if (!ok) continue;
          placed.push({ tech: t, start: s, end: e, parts: o.parts, skill: o.skill, order: o.id });
          dfs(i + 1, completed + 1, overtime + Math.max(0, e - se));
          placed.pop();
        }
      }
    }
    dfs(i + 1, completed, overtime);
  }

  function snapshot() {
    return placed
      .map((p) => ({ order: p.order, tech: techs[p.tech].id, start: p.start, end: p.end }))
      .sort((a, b) => String(a.order).localeCompare(String(b.order), undefined, { numeric: true }));
  }

  dfs(0, 0, 0);
  return { best, count, sols };
}

const canonSols = (sols) =>
  sols
    .map((s) => s.map((a) => `${a.order}@${a.tech}:${a.start}-${a.end}`).sort().join('|'))
    .sort();

// ---------- fixtures ----------
function nineOrderInstance() {
  return {
    orders: [
      { id: 'o1', duration: 2, window: [0, 4], parts: ['pA'], skill: 'mech' },
      { id: 'o2', duration: 2, window: [0, 4], parts: ['pA'], skill: 'mech' },
      { id: 'o3', duration: 1, window: [1, 5], parts: ['pB'], skill: 'elec' },
      { id: 'o4', duration: 2, window: [2, 6], parts: ['pB'], skill: 'mech' },
      { id: 'o5', duration: 3, window: [0, 8], parts: [], skill: 'mech' },
      { id: 'o6', duration: 1, window: [3, 6], parts: ['pA'], skill: 'elec' },
      { id: 'o7', duration: 2, window: [4, 8], parts: ['pB'], skill: 'mech' },
      { id: 'o8', duration: 2, window: [6, 10], parts: ['pA'], skill: 'mech' },
      { id: 'o9', duration: 1, window: [0, 10], parts: [], skill: 'elec' },
    ],
    techs: [
      { id: 'T1', shifts: [[0, 8]], skills: ['mech', 'elec'] },
      { id: 'T2', shifts: [[2, 10]], skills: ['mech'] },
    ],
    kits: [
      { id: 'K1', qty: 1, compatible: ['pA'] },
      { id: 'K2', qty: 2, compatible: ['pB'] },
      { id: 'K3', qty: 1, compatible: ['pA', 'pB'] },
    ],
  };
}

function offByOneInstance(qty) {
  return {
    orders: [
      { id: 'w1', duration: 2, window: [0, 3], parts: ['seal'], skill: 'mech' },
      { id: 'w2', duration: 2, window: [0, 3], parts: ['seal'], skill: 'mech' },
    ],
    techs: [
      { id: 't1', shifts: [[0, 8]], skills: ['mech'] },
      { id: 't2', shifts: [[0, 8]], skills: ['mech'] },
    ],
    kits: [{ id: 'kit-seal', qty, compatible: ['seal'] }],
  };
}

// ---------- 1) 9-order case vs branch-and-bound reference ----------
test('9-order instance matches independent branch-and-bound reference', () => {
  const instance = nineOrderInstance();
  const mine = solve(instance);
  const ref = referenceBnB(instance);

  assert.equal(mine.status, 'OPTIMAL');
  assert.equal(mine.objective.completed, ref.best.completed);
  assert.equal(mine.objective.overtime, ref.best.overtime);
  assert.equal(mine.objective.switches, ref.best.switches);
  assert.equal(mine.optimalCount, ref.count, 'must enumerate every tied optimum');
  assert.deepEqual(canonSols(mine.solutions), canonSols(ref.sols));
});

// ---------- 2) kit qty off-by-one -> verifiable conflict ----------
test('kit quantity off by one yields a re-verifiable minimal conflict', () => {
  const short = offByOneInstance(1);
  const result = plan(short);
  assert.equal(result.objective.completed, 1);
  assert.equal(result.objective.total, 2);
  assert.ok(result.certificate, 'certificate attached');
  assert.deepEqual(result.certificate.orders, ['w1', 'w2']);
  assert.equal(result.certificate.bottleneck.type, 'kit');
  assert.deepEqual(result.certificate.bottleneck.demand, { seal: 2 });
  assert.deepEqual(result.certificate.bottleneck.kits.map((k) => [k.id, k.qty]), [['kit-seal', 1]]);
  assert.equal(result.certificateHash, result.certificate.hash);

  const verification = verifyCertificate(short, result.certificate);
  assert.equal(verification.valid, true);
  assert.ok(verification.checks.every((c) => c.pass));

  // one more kit unit resolves the conflict
  const enough = plan(offByOneInstance(2));
  assert.equal(enough.objective.completed, 2);
  assert.equal(enough.certificate, undefined);
});

// ---------- 3) lock / unlock consistency with full solve ----------
test('locking one assignment then re-solving stays consistent; unlock restores', () => {
  const instance = nineOrderInstance();
  const full = solve(instance);
  assert.equal(full.status, 'OPTIMAL');

  const pick = full.assignments.find((a) => a.order === 'o4');
  assert.ok(pick, 'o4 is assigned in the representative optimum');

  const locked = solve(instance, { locks: [{ order: pick.order, tech: pick.tech, start: pick.start }] });
  assert.equal(locked.status, 'OPTIMAL');
  assert.deepEqual(
    { completed: locked.objective.completed, overtime: locked.objective.overtime, switches: locked.objective.switches },
    { completed: full.objective.completed, overtime: full.objective.overtime, switches: full.objective.switches },
    'incremental re-solve under a lock keeps the same optimum'
  );
  const lockedEntry = locked.assignments.find((a) => a.order === pick.order);
  assert.deepEqual(
    { tech: lockedEntry.tech, start: lockedEntry.start },
    { tech: pick.tech, start: pick.start },
    'lock is honored'
  );
  assert.equal(lockedEntry.locked, true);

  const unlocked = solve(instance);
  assert.deepEqual(unlocked.objective, full.objective, 'unlock restores the full-solve optimum');
  assert.equal(unlocked.optimalCount, full.optimalCount);
});

test('conflicting locks are rejected with ERR_LOCK', () => {
  const instance = nineOrderInstance();
  const res = solve(instance, {
    locks: [
      { order: 'o1', tech: 'T1', start: 0 },
      { order: 'o2', tech: 'T1', start: 1 }, // overlaps o1 on T1
    ],
  });
  assert.equal(res.status, 'ERR_LOCK');
});

// ---------- 4) window end earlier than start -> ERR_WINDOW ----------
test('window end earlier than start raises ERR_WINDOW', () => {
  const bad = {
    orders: [{ id: 'bad', duration: 1, window: [5, 2], parts: [], skill: 'mech' }],
    techs: [{ id: 't', shifts: [[0, 8]], skills: ['mech'] }],
    kits: [],
  };
  assert.throws(() => solve(bad), (err) => err.code === ERR_WINDOW && err.order === 'bad');

  const { code, output } = runCli([], JSON.stringify(bad));
  assert.equal(code, 2);
  const out = JSON.parse(output);
  assert.equal(out.error, ERR_WINDOW);
  assert.equal(out.order, 'bad');
});

// ---------- UNKNOWN must not be treated as infeasible ----------
test('node-limit exhaustion reports UNKNOWN, never INFEASIBLE', () => {
  const instance = nineOrderInstance();
  const res = solve(instance, { nodeLimit: 1 });
  assert.equal(res.status, 'UNKNOWN');
  assert.equal(res.objective, null);

  const planned = plan(instance, { nodeLimit: 1, requireAll: true });
  assert.equal(planned.status, 'UNKNOWN');
  assert.equal(planned.certificate, undefined);
});

// ---------- certificate hash stability ----------
test('certificate hash is deterministic over key order', () => {
  const instance = offByOneInstance(1);
  const a = buildCertificate(instance).certificate;
  const b = buildCertificate(instance).certificate;
  assert.equal(a.hash, b.hash);
  const { hash, ...body } = a;
  assert.equal(hashObject(body), hash);
});

// ---------- CLI end-to-end ----------
test('CLI emits JSON with certificate hash for a partial plan', () => {
  const { code, output } = runCli([], JSON.stringify(offByOneInstance(1)));
  assert.equal(code, 0);
  const out = JSON.parse(output);
  assert.equal(out.status, 'OPTIMAL');
  assert.equal(out.objective.completed, 1);
  assert.match(out.certificateHash, /^[0-9a-f]{64}$/);
  assert.equal(out.certificateValid, true);
});

test('CLI --require-all exits 1 with INFEASIBLE when orders cannot all complete', () => {
  const { code, output } = runCli(['--require-all'], JSON.stringify(offByOneInstance(1)));
  assert.equal(code, 1);
  assert.equal(JSON.parse(output).status, 'INFEASIBLE');
});
