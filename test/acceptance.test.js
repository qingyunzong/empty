import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve, Scheduler, ERR_CURVE, ERR_DOMAIN } from '../src/index.js';

const TOL = 1e-9;

// ---------- 测试内独立的离散时间枚举对照实现 ----------

function bfPrepare(b) {
  const duration = b.curve[b.curve.length - 1].t;
  const interp = (pts, key) => (t) => {
    if (t <= pts[0].t) return pts[0][key];
    if (t >= pts[pts.length - 1].t) return pts[pts.length - 1][key];
    for (let i = 0; i + 1 < pts.length; i++) {
      if (t <= pts[i + 1].t) {
        const f = (t - pts[i].t) / (pts[i + 1].t - pts[i].t);
        return pts[i][key] + f * (pts[i + 1][key] - pts[i][key]);
      }
    }
    return pts[pts.length - 1][key];
  };
  const tempAt = interp(b.curve, 'temp');
  const powerAt = interp(b.power, 'power');
  return { ...b, duration, tempAt, powerAt: (t) => (t > duration ? 0 : powerAt(t)) };
}

function bfCompat(members, cfg) {
  const alloy = members[0].alloy;
  let mass = 0;
  let lo = -Infinity;
  let hi = Infinity;
  for (const b of members) {
    if (b.alloy !== alloy) return false;
    mass += b.mass;
    lo = Math.max(lo, b.band[0]);
    hi = Math.min(hi, b.band[1]);
  }
  if (mass > cfg.capacity + TOL || lo > hi + TOL) return false;
  const runDuration = Math.max(...members.map((b) => b.duration));
  const knots = new Set();
  for (const b of members) {
    for (const p of b.curve) {
      if (p.t <= runDuration + TOL) knots.add(Math.min(p.t, runDuration));
    }
  }
  for (const t of knots) {
    let mn = Infinity;
    let mx = -Infinity;
    for (const b of members) {
      if (t > b.duration + TOL) continue;
      const tmp = b.tempAt(t);
      mn = Math.min(mn, tmp);
      mx = Math.max(mx, tmp);
    }
    if (mx - mn > cfg.deltaMax + TOL) return false;
  }
  return true;
}

function keyLess(a, b) {
  if (a.makespan < b.makespan - TOL) return true;
  if (a.makespan > b.makespan + TOL) return false;
  if (a.peakValley < b.peakValley - TOL) return true;
  if (a.peakValley > b.peakValley + TOL) return false;
  return a.runCount < b.runCount;
}

function keyEq(a, b) {
  return Math.abs(a.makespan - b.makespan) <= TOL
    && Math.abs(a.peakValley - b.peakValley) <= TOL
    && a.runCount === b.runCount;
}

function bruteForce(rawBatches, cfg) {
  const batches = rawBatches.map(bfPrepare);
  const n = batches.length;
  let best = null;
  let count = 0;
  const runs = [];
  function recPlace(runObjs) {
    if (runObjs.some((r) => Math.max(...r.profile) > cfg.peak + TOL)) return;
    const H = runObjs.reduce((s, r) => s + r.duration, 0);
    const usage = new Float64Array(Math.ceil(H - TOL) + 2);
    const order = runObjs.map((_, k) => k).sort((a, b) => runObjs[b].duration - runObjs[a].duration);
    function rec(k, curMakespan) {
      if (best && curMakespan > best.makespan + TOL) return;
      if (k === order.length) {
        const slotsUsed = Math.max(1, Math.ceil(curMakespan - TOL));
        let hi = -Infinity;
        let lo = Infinity;
        for (let t = 0; t < slotsUsed; t++) {
          hi = Math.max(hi, usage[t]);
          lo = Math.min(lo, usage[t]);
        }
        const key = { makespan: curMakespan, peakValley: hi - lo, runCount: runObjs.length };
        if (!best || keyLess(key, best)) {
          best = key;
          count = 1;
        } else if (keyEq(key, best)) {
          count++;
        }
        return;
      }
      const r = runObjs[order[k]];
      const cap = best ? Math.min(H, best.makespan) : H;
      for (let s = 0; s + r.duration <= cap + TOL; s++) {
        let ok = true;
        for (let j = 0; j < r.profile.length; j++) {
          if (usage[s + j] + r.profile[j] > cfg.peak + TOL) { ok = false; break; }
        }
        if (!ok) continue;
        for (let j = 0; j < r.profile.length; j++) usage[s + j] += r.profile[j];
        rec(k + 1, Math.max(curMakespan, s + r.duration));
        for (let j = 0; j < r.profile.length; j++) usage[s + j] -= r.profile[j];
      }
    }
    rec(0, 0);
  }
  function recP(i) {
    if (i === n) {
      const runObjs = runs.map((idxs) => {
        const members = idxs.map((x) => batches[x]);
        const duration = Math.max(...members.map((b) => b.duration));
        const slots = Math.max(1, Math.ceil(duration - TOL));
        const profile = [];
        for (let j = 0; j < slots; j++) profile.push(members.reduce((p, b) => p + b.powerAt(j), 0));
        return { members, duration, profile };
      });
      recPlace(runObjs);
      return;
    }
    for (const run of runs) {
      const cand = [...run, i].map((x) => batches[x]);
      if (bfCompat(cand, cfg)) {
        run.push(i);
        recP(i + 1);
        run.pop();
      }
    }
    runs.push([i]);
    recP(i + 1);
    runs.pop();
  }
  recP(0);
  return { best, count };
}

// ---------- 公共夹具 ----------

function sixBatches() {
  return [
    { id: 'a1', alloy: 'A', band: [780, 860], mass: 2, curve: [{ t: 0, temp: 20 }, { t: 1, temp: 820, phase: 'hold' }, { t: 2, temp: 820, phase: 'hold' }, { t: 3, temp: 300 }], power: [{ t: 0, power: 5 }, { t: 1, power: 4 }, { t: 2, power: 2 }, { t: 3, power: 1 }] },
    { id: 'a2', alloy: 'A', band: [800, 880], mass: 3, curve: [{ t: 0, temp: 20 }, { t: 1, temp: 840, phase: 'hold' }, { t: 2, temp: 840, phase: 'hold' }, { t: 3, temp: 400 }], power: [{ t: 0, power: 4 }, { t: 1, power: 4 }, { t: 2, power: 2 }, { t: 3, power: 1 }] },
    { id: 'a3', alloy: 'A', band: [750, 830], mass: 2, curve: [{ t: 0, temp: 20 }, { t: 1, temp: 800 }, { t: 2, temp: 800, phase: 'hold' }, { t: 3, temp: 250 }], power: [{ t: 0, power: 5 }, { t: 1, power: 3 }, { t: 2, power: 2 }, { t: 3, power: 1 }] },
    { id: 'b1', alloy: 'B', band: [600, 700], mass: 3, curve: [{ t: 0, temp: 20 }, { t: 1, temp: 650 }, { t: 2, temp: 650, phase: 'hold' }, { t: 3, temp: 200 }], power: [{ t: 0, power: 4 }, { t: 1, power: 3 }, { t: 2, power: 2 }, { t: 3, power: 1 }] },
    { id: 'b2', alloy: 'B', band: [620, 720], mass: 2, curve: [{ t: 0, temp: 20 }, { t: 1, temp: 680 }, { t: 2, temp: 680, phase: 'hold' }, { t: 3, temp: 300 }], power: [{ t: 0, power: 3 }, { t: 1, power: 3 }, { t: 2, power: 2 }, { t: 3, power: 1 }] },
    { id: 'b3', alloy: 'B', band: [580, 690], mass: 2, curve: [{ t: 0, temp: 20 }, { t: 1, temp: 620 }, { t: 2, temp: 620, phase: 'hold' }, { t: 3, temp: 250 }], power: [{ t: 0, power: 4 }, { t: 1, power: 3 }, { t: 2, power: 3 }, { t: 3, power: 1 }] },
  ];
}

const CFG = { peak: 9, capacity: 5, deltaMax: 80, grid: 1, nodeLimit: 5000000, maxSolutions: 100000 };

// 验收 1：6 批对照离散时间枚举
test('验收1: 6批求解结果与独立离散时间枚举一致', () => {
  const batches = sixBatches();
  const res = solve(batches, CFG);
  assert.equal(res.status, 'OPTIMAL');
  const bf = bruteForce(batches, CFG);
  assert.ok(bf.best, '枚举应找到可行解');
  assert.ok(Math.abs(res.objective.makespan - bf.best.makespan) <= TOL, `makespan ${res.objective.makespan} != ${bf.best.makespan}`);
  assert.ok(Math.abs(res.objective.peakValley - bf.best.peakValley) <= TOL, 'peakValley 不一致');
  assert.equal(res.objective.runCount, bf.best.runCount, 'runCount 不一致');
  assert.equal(res.tiesComplete, true);
  assert.equal(res.schedules.length, bf.count, `并列最优数量 ${res.schedules.length} != ${bf.count}`);
  for (const s of res.schedules) {
    assert.ok(keyEq(s, bf.best), '每个返回解都应达到最优目标值');
  }
});

// 验收 2：峰值恰等于需求边界可行
test('验收2: 峰值恰等于需求边界时可行', () => {
  const mk = (id, p) => ({
    id, alloy: 'A', band: [800, 860], mass: 1,
    curve: [{ t: 0, temp: 20 }, { t: 1, temp: 830 }, { t: 2, temp: 830, phase: 'hold' }],
    power: [{ t: 0, power: p }, { t: 2, power: p }],
  });
  const res = solve([mk('x', 4), mk('y', 5)], { ...CFG, peak: 9 });
  assert.equal(res.status, 'OPTIMAL');
  assert.equal(res.objective.makespan, 2);
  assert.equal(res.objective.runCount, 1);
  assert.ok(Math.abs(res.schedules[0].peakUsage - 9) <= TOL, `峰值占用 ${res.schedules[0].peakUsage} 应恰为 9`);
  // 峰值略低于边界 -> 两批无法同刻并炉，只能串行
  const tight = solve([mk('x', 4), mk('y', 5)], { ...CFG, peak: 8.5 });
  assert.equal(tight.status, 'OPTIMAL');
  assert.equal(tight.objective.makespan, 4);
  assert.equal(tight.objective.runCount, 2);
});

// 验收 3：改温度带后增量与全量一致，undo 恢复
function approxEqual(a, b, path = 'root') {
  if (typeof a === 'number' && typeof b === 'number') {
    assert.ok(Math.abs(a - b) <= 1e-9, `${path}: ${a} != ${b}`);
    return;
  }
  assert.equal(typeof a, typeof b, path);
  if (Array.isArray(a)) {
    assert.equal(a.length, b.length, `${path}.length`);
    a.forEach((v, i) => approxEqual(v, b[i], `${path}[${i}]`));
    return;
  }
  if (a && typeof a === 'object') {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${path} keys`);
    for (const k of Object.keys(a)) approxEqual(a[k], b[k], `${path}.${k}`);
    return;
  }
  assert.equal(a, b, path);
}

test('验收3: 改温度带后增量重排与全量一致，undo 恢复', () => {
  const sched = new Scheduler(CFG);
  for (const b of sixBatches().slice(0, 4)) sched.addBatch(b);
  const before = sched.resolve();
  assert.equal(before.status, 'OPTIMAL');

  sched.editBatch('a3', { band: [870, 950] }); // 与 a1 温度带不再相交
  const inc = sched.resolve();
  assert.equal(inc.status, 'OPTIMAL');

  const full = solve(sched.listBatches(), CFG); // 全量重算
  assert.equal(full.status, 'OPTIMAL');
  approxEqual(inc, full); // 增量 == 全量

  assert.equal(sched.undo(), true);
  const restored = sched.resolve();
  approxEqual(restored, before); // undo 恢复到浮点容差内
});

// 验收 4：曲线时间倒挂 ERR_CURVE，功率 NaN ERR_DOMAIN
test('验收4: 曲线时间倒挂报 ERR_CURVE，功率 NaN 报 ERR_DOMAIN', () => {
  const sched = new Scheduler(CFG);
  const base = { id: 'bad', alloy: 'A', band: [800, 860], mass: 1 };

  assert.throws(
    () => sched.addBatch({ ...base, id: 'b-time', curve: [{ t: 0, temp: 20 }, { t: 2, temp: 500 }, { t: 1, temp: 600 }], power: [{ t: 0, power: 1 }] }),
    (e) => e.code === ERR_CURVE,
  );
  assert.throws(
    () => sched.addBatch({ ...base, id: 'b-nan', curve: [{ t: 0, temp: 20 }, { t: 1, temp: 500 }], power: [{ t: 0, power: NaN }, { t: 1, power: 1 }] }),
    (e) => e.code === ERR_DOMAIN,
  );
  assert.throws(
    () => sched.addBatch({ ...base, id: 'b-hold', curve: [{ t: 0, temp: 20 }, { t: 1, temp: 500, phase: 'hold' }, { t: 2, temp: 450, phase: 'hold' }], power: [{ t: 0, power: 1 }] }),
    (e) => e.code === ERR_CURVE, // 负斜率保温段
  );
  // 校验失败不应污染状态
  assert.equal(sched.listBatches().length, 0);
});
