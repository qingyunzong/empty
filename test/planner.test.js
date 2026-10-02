import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Planner } from '../src/planner.js';
import { verifyCertificate } from '../src/certificate.js';
import { actionToString, comparePlans } from '../src/domain.js';

const PROBLEM_8 = JSON.parse(readFileSync(new URL('../examples/sat.json', import.meta.url), 'utf8'));
const CAL_CONFLICT = JSON.parse(readFileSync(new URL('../examples/unsat.json', import.meta.url), 'utf8'));

// 独立全枚举（无记忆化、独立于求解器的转移实现），用于对照目标值与全部并列解。
// 动作空间与求解器一致地剔除无效果维护动作（wear=0 换刀 / calDue 满时校准）：
// 这类动作只增加停机与预算消耗，包含它的计划被严格支配，不可能出现在最优并列集中。
function enumerateAll(p) {
  const ops = p.ops;
  const toolWear0 = p.initial?.toolWear ?? 0;
  const calDue0 = p.initial?.calDue ?? p.calInterval;
  const best = { downtime: Infinity, seqs: [] };
  const maxLen = 4 * ops.length + 4;
  const rec = (wear, cal, budget, i, downtime, seq) => {
    if (downtime > best.downtime || seq.length > maxLen) return;
    if (i === ops.length) {
      if (downtime < best.downtime) {
        best.downtime = downtime;
        best.seqs = [seq];
      } else {
        best.seqs.push(seq);
      }
      return;
    }
    const op = ops[i];
    if (wear + op.wear <= p.toolLife && op.duration <= cal) {
      rec(wear + op.wear, cal - op.duration, budget, i + 1, downtime, [...seq, `run:${op.id}`]);
    }
    if (wear > 0 && budget >= p.costs.changeTool.cost) {
      rec(0, cal, budget - p.costs.changeTool.cost, i, downtime + p.costs.changeTool.time, [...seq, 'changeTool']);
    }
    if (cal < p.calInterval && budget >= p.costs.calibrate.cost) {
      rec(wear, p.calInterval, budget - p.costs.calibrate.cost, i, downtime + p.costs.calibrate.time, [...seq, 'calibrate']);
    }
  };
  rec(toolWear0, calDue0, p.budget, 0, 0, []);
  return best;
}

test('验收1: 8 工序与全枚举对照目标值与全部并列解', () => {
  const result = new Planner(PROBLEM_8).solve();
  const brute = enumerateAll(PROBLEM_8);
  assert.equal(result.status, 'SAT');
  assert.equal(brute.downtime, 10); // 2 次换刀 * 2 + 2 次校准 * 3
  assert.equal(result.downtime, brute.downtime);
  const solverSeqs = result.plans.map((plan) => plan.actions.map(actionToString).join(','));
  const bruteSeqs = brute.seqs.map((seq) => seq.join(','));
  assert.ok(bruteSeqs.length > 1, '应存在并列最优解');
  assert.equal(solverSeqs.length, bruteSeqs.length);
  assert.deepEqual(new Set(solverSeqs), new Set(bruteSeqs));
  // 并列解按 (停机, 预算余量, 动作字典序) 排序且全部保留
  for (let i = 1; i < result.plans.length; i += 1) {
    assert.ok(comparePlans(result.plans[i - 1], result.plans[i]) <= 0);
  }
  assert.ok(result.plans.every((plan) => plan.downtime === result.downtime));
});

test('验收2: calDue 冲突返回可复验的最小不可行证书', () => {
  const result = new Planner(CAL_CONFLICT).solve();
  assert.equal(result.status, 'UNSAT');
  assert.notEqual(result.status, 'UNKNOWN'); // UNSAT 不能由 UNKNOWN 冒充
  const cert = result.certificate;
  assert.equal(cert.type, 'UNSAT_CERTIFICATE');
  assert.equal(cert.exhaustive, true);
  const byKind = (kind) => cert.relaxations.filter((r) => r.kind === kind);
  // 删去一个到期约束即可可行（c2、c3 可行；c1 不可行，也如实记录）
  const removals = byKind('removeCalDueConstraint');
  assert.equal(removals.length, 3);
  assert.equal(removals.find((r) => r.op === 'c1').feasible, false);
  assert.equal(removals.find((r) => r.op === 'c2').feasible, true);
  assert.equal(removals.find((r) => r.op === 'c3').feasible, true);
  // 增加一单位预算即可可行
  const addBudget = byKind('addBudget');
  assert.equal(addBudget.length, 1);
  assert.equal(addBudget[0].amount, 1);
  assert.equal(addBudget[0].feasible, true);
  // 可行松弛均附目击计划
  for (const rel of cert.relaxations) {
    assert.equal(rel.witness !== null, rel.feasible);
  }
  // 独立复验
  const verification = verifyCertificate(CAL_CONFLICT, cert);
  assert.equal(verification.valid, true, JSON.stringify(verification.checks));
});

test('验收3: 撤销三步后与重新加载快照一致，且仅重算受影响分支', () => {
  const planner = new Planner(PROBLEM_8);
  planner.apply({ type: 'run', op: 'o1' });
  planner.apply({ type: 'run', op: 'o2' });
  const snapshot = planner.snapshot();
  planner.apply({ type: 'changeTool' });
  planner.apply({ type: 'run', op: 'o3' });
  planner.apply({ type: 'calibrate' });
  assert.equal(planner.depth, 5);
  planner.solve(); // 填充缓存
  const undone = [planner.undo(), planner.undo(), planner.undo()];
  assert.deepEqual(undone.map((a) => a.type), ['calibrate', 'run', 'changeTool']);
  assert.equal(planner.depth, 2);
  const reloaded = Planner.restore(snapshot);
  assert.deepEqual(planner.state, reloaded.state);
  assert.deepEqual(planner.path, reloaded.path);
  const afterUndo = planner.solve();
  const fromSnapshot = reloaded.solve();
  assert.deepEqual(afterUndo.plans, fromSnapshot.plans);
  assert.equal(afterUndo.downtime, fromSnapshot.downtime);
  // 增量失效：未受影响分支命中缓存，没有从头重算
  assert.ok(afterUndo.stats.cacheHits > 0, '撤销后重解应命中未受影响分支的缓存');
  assert.equal(planner.undo().type, 'run');
  assert.equal(planner.undo().type, 'run');
  assert.equal(planner.undo(), null); // 空历史撤销返回 null
  assert.equal(planner.depth, 0);
});

test('验收4: 预算为负或寿命 NaN 报 ERR_DOMAIN', () => {
  const expectDomain = (mutate) => {
    const problem = mutate(JSON.parse(JSON.stringify(PROBLEM_8)));
    assert.throws(() => new Planner(problem), (err) => err.code === 'ERR_DOMAIN');
  };
  expectDomain((p) => { p.budget = -1; return p; });
  expectDomain((p) => { p.budget = Number.NaN; return p; });
  expectDomain((p) => { p.toolLife = Number.NaN; return p; });
  expectDomain((p) => { p.toolLife = 0; return p; });
  expectDomain((p) => { p.ops[0].wear = Number.NaN; return p; });
  expectDomain((p) => { p.initial = { toolWear: Number.NaN }; return p; });
  expectDomain((p) => { p.costs.calibrate.cost = -0.5; return p; });
});

test('前置条件违反报 ERR_PRECONDITION', () => {
  const planner = new Planner(CAL_CONFLICT);
  planner.apply({ type: 'run', op: 'c1' }); // calDue 5 -> 1
  assert.throws(() => planner.apply({ type: 'run', op: 'c2' }), (err) => {
    assert.equal(err.code, 'ERR_PRECONDITION');
    assert.match(err.message, /calibration due/);
    return true;
  });
  assert.throws(() => planner.apply({ type: 'run', op: 'c3' }), (err) => err.code === 'ERR_PRECONDITION');
  assert.throws(() => planner.apply({ type: 'jump' }), (err) => err.code === 'ERR_DOMAIN');
  // 预算耗尽后校准报前置条件错误
  const poor = new Planner({ ...CAL_CONFLICT, budget: 0 });
  poor.apply({ type: 'run', op: 'c1' });
  assert.throws(() => poor.apply({ type: 'calibrate' }), (err) => err.code === 'ERR_PRECONDITION');
});
