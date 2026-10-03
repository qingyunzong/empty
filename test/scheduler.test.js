'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  Searcher,
  enumerateOptimal,
  buildCertificate,
  verifyCertificate,
  objectiveOf,
} = require('../src/scheduler');

// 8 工序, 换刀时机有自由度 -> 存在并列最优解
const EIGHT_OP_CONFIG = {
  toolLife: 6,
  toolWear: 6,
  calInterval: 100,
  calDue: 100,
  budget: 10,
  costs: {
    changeTool: { time: 1, money: 1 },
    calibrate: { time: 1, money: 1 },
  },
  ops: Array.from({ length: 8 }, () => ({ wear: 2, duration: 1 })),
};

const CAL_CONFLICT_CONFIG = {
  toolLife: 10,
  toolWear: 10,
  calInterval: 5,
  calDue: 1,
  budget: 1,
  costs: {
    changeTool: { time: 1, money: 1 },
    calibrate: { time: 1, money: 2 },
  },
  ops: [{ wear: 1, duration: 2 }],
};

const planSet = (plans) => new Set(plans.map((p) => JSON.stringify(p)));

test('验收1: 8工序 记忆化搜索与全枚举的目标及并列解一致', () => {
  const searcher = new Searcher(EIGHT_OP_CONFIG);
  const res = searcher.solve();
  assert.ok(res, 'expected SAT');
  const brute = enumerateOptimal(EIGHT_OP_CONFIG);
  assert.ok(brute, 'expected brute-force SAT');
  assert.deepEqual(res.key, brute.key, 'objective key mismatch');
  assert.deepEqual(objectiveOf(res.key), { downtime: 2, budgetSpent: 2, actions: 10 });
  assert.ok(res.plans.length > 1, 'expected tied optimal plans');
  assert.deepEqual(planSet(res.plans), planSet(brute.plans), 'tied plan sets differ');
  assert.equal(res.plans.length, brute.plans.length);
});

test('验收2: calDue 冲突返回可复验 UNSAT 证书', () => {
  const cert = buildCertificate(CAL_CONFLICT_CONFIG);
  assert.ok(cert, 'expected certificate');
  assert.equal(cert.status, 'UNSAT');
  assert.equal(cert.complete, true, 'certificate must not be UNKNOWN');
  assert.ok(verifyCertificate(CAL_CONFLICT_CONFIG, cert), 'certificate must verify');
  const kinds = cert.relaxations.map((r) => r.kind);
  assert.ok(kinds.includes('removeCalDueConstraint'));
  assert.ok(kinds.includes('addBudget'));
  for (const rel of cert.relaxations) {
    assert.equal(rel.feasible, true);
    assert.ok(rel.objective && Array.isArray(rel.plan));
  }
});

test('验收2b: 篡改/伪造证书无法通过复验', () => {
  const cert = buildCertificate(CAL_CONFLICT_CONFIG);
  assert.equal(verifyCertificate(CAL_CONFLICT_CONFIG, { ...cert, complete: false }), false);
  const tampered = JSON.parse(JSON.stringify(cert));
  tampered.relaxations[0].objective.downtime += 1;
  assert.equal(verifyCertificate(CAL_CONFLICT_CONFIG, tampered), false);
  const fake = { status: 'UNSAT', complete: true, relaxations: [{ kind: 'addBudget', amount: 1, objective: { downtime: 0, budgetSpent: 0, actions: 0 } }] };
  assert.equal(verifyCertificate(CAL_CONFLICT_CONFIG, fake), false);
  // SAT 问题上 UNSAT 证书必须被拒绝
  assert.equal(verifyCertificate(EIGHT_OP_CONFIG, cert), false);
});

test('验收3: 撤销三步后与重新加载快照一致', () => {
  const searcher = new Searcher(EIGHT_OP_CONFIG);
  searcher.apply({ type: 'run' });
  searcher.apply({ type: 'run' });
  const snap = searcher.snapshot();
  searcher.apply({ type: 'run' });
  searcher.apply({ type: 'changeTool' });
  searcher.apply({ type: 'run' });
  assert.equal(searcher.undo(), true);
  assert.equal(searcher.undo(), true);
  assert.equal(searcher.undo(), true);
  assert.equal(searcher.snapshot(), snap, 'state after 3 undos must equal snapshot');
  const reloaded = Searcher.from(EIGHT_OP_CONFIG, snap);
  const a = searcher.solve();
  const b = reloaded.solve();
  assert.deepEqual(a.key, b.key);
  assert.deepEqual(planSet(a.plans), planSet(b.plans));
  // 增量: 撤销前的 memo 仍保留, 受影响分支之外无需重算
  assert.ok(searcher.memo.size > 0);
  // 撤销到空路径后 undo 返回 false
  const fresh = new Searcher(EIGHT_OP_CONFIG);
  assert.equal(fresh.undo(), false);
});

test('验收4: 负预算或寿命 NaN 报 ERR_DOMAIN', () => {
  assert.throws(
    () => new Searcher({ ...EIGHT_OP_CONFIG, budget: -1 }),
    (err) => err.code === 'ERR_DOMAIN',
  );
  assert.throws(
    () => new Searcher({ ...EIGHT_OP_CONFIG, toolWear: NaN }),
    (err) => err.code === 'ERR_DOMAIN',
  );
  assert.throws(
    () => new Searcher({ ...EIGHT_OP_CONFIG, toolLife: NaN }),
    (err) => err.code === 'ERR_DOMAIN',
  );
});

test('CLI: 读 plan.json 输出 plan 或证书', () => {
  const { run } = require('../cli');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-'));
  const satFile = path.join(dir, 'sat.json');
  const unsatFile = path.join(dir, 'unsat.json');
  const badFile = path.join(dir, 'bad.json');
  fs.writeFileSync(satFile, JSON.stringify(EIGHT_OP_CONFIG));
  fs.writeFileSync(unsatFile, JSON.stringify(CAL_CONFLICT_CONFIG));
  fs.writeFileSync(badFile, JSON.stringify({ ...EIGHT_OP_CONFIG, budget: -5 }));

  const sat = run(satFile);
  assert.equal(sat.code, 0);
  const satOut = JSON.parse(sat.stdout);
  assert.equal(satOut.status, 'SAT');
  assert.deepEqual(satOut.objective, { downtime: 2, budgetSpent: 2, actions: 10 });
  assert.equal(satOut.plans.length, satOut.tiedPlans);

  const unsat = run(unsatFile);
  assert.equal(unsat.code, 0);
  const unsatOut = JSON.parse(unsat.stdout);
  assert.equal(unsatOut.status, 'UNSAT');
  assert.equal(unsatOut.complete, true);
  assert.ok(unsatOut.relaxations.length >= 2);

  const bad = run(badFile);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /ERR_DOMAIN/);
});
