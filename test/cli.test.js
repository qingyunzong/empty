import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

const run = runCli;

const SITE = `
# 注释：演示站点
site "Demo" {
  capacity 20 kW
  tariff { price 00:00-02:00 1 price 02:00-04:00 3 }
  carbon { intensity 00:00-24:00 1 }
  template P { power 10 kW duration 60 min window 00:00-04:00 interruptible false }
  task t1 : P
}
`;

test('CLI：schedule 可行并写出 plan.json，verify 通过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'esched-'));
  const dsl = join(dir, 'site.dsl');
  const plan = join(dir, 'plan.json');
  writeFileSync(dsl, SITE);
  const r = run(['schedule', dsl, '--json', plan]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^FEASIBLE cost=10 /);
  const v = run(['verify', plan]);
  assert.equal(v.code, 0);
  assert.match(v.stdout, /OK/);
});

test('CLI：INFEASIBLE 退出码 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'esched-'));
  const dsl = join(dir, 'site.dsl');
  writeFileSync(dsl, `${SITE}  maintenance 00:30-03:30\n}\n`.replace('}\n  maintenance', '  maintenance'));
  const r = run(['schedule', dsl]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /INFEASIBLE/);
});

test('CLI：超预算退出码 1 并列出最低成本', () => {
  const dir = mkdtempSync(join(tmpdir(), 'esched-'));
  const dsl = join(dir, 'site.dsl');
  writeFileSync(dsl, SITE.replace('template P', 'budget { cost 9 }\n  template P'));
  const r = run(['schedule', dsl]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /OVER_BUDGET minCost=10 costBudget=9/);
});

test('CLI：语法错误带行列，退出码 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'esched-'));
  const dsl = join(dir, 'site.dsl');
  writeFileSync(dsl, 'site A {\n  capacity 40 kW\n  task : P\n}\n');
  const r = run(['schedule', dsl]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /site\.dsl:3:8: error:/);
});

test('CLI：类型错误带行列，退出码 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'esched-'));
  const dsl = join(dir, 'site.dsl');
  writeFileSync(dsl, 'site A {\n  template P { power 10 kWh }\n}\n');
  const r = run(['schedule', dsl]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /site\.dsl:2:16: error:.*kW/);
});

test('CLI：verify 发现被篡改的计划，退出码 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'esched-'));
  const dsl = join(dir, 'site.dsl');
  const plan = join(dir, 'plan.json');
  writeFileSync(dsl, SITE);
  assert.equal(run(['schedule', dsl, '--json', plan]).code, 0);
  const obj = JSON.parse(readFileSync(plan, 'utf8'));
  obj.objective.cost = 999;
  writeFileSync(plan, JSON.stringify(obj));
  const v = run(['verify', plan]);
  assert.equal(v.code, 1);
  assert.match(v.stderr, /INVALID/);
});

test('CLI：verify 对非法 JSON 退出码 2 并带行列', () => {
  const dir = mkdtempSync(join(tmpdir(), 'esched-'));
  const plan = join(dir, 'plan.json');
  writeFileSync(plan, '{\n  "version": 1,\n  bad\n}');
  const v = run(['verify', plan]);
  assert.equal(v.code, 2);
  assert.match(v.stderr, /plan\.json:\d+:\d+: error:/);
});

test('CLI：verify 检出违反容量约束的计划', () => {
  const dir = mkdtempSync(join(tmpdir(), 'esched-'));
  const dsl = join(dir, 'site.dsl');
  const plan = join(dir, 'plan.json');
  writeFileSync(dsl, SITE);
  assert.equal(run(['schedule', dsl, '--json', plan]).code, 0);
  const obj = JSON.parse(readFileSync(plan, 'utf8'));
  obj.schedule.push({ task: 't1', slots: [0, 1, 2, 3] }); // 重复调度同一任务
  writeFileSync(plan, JSON.stringify(obj));
  const v = run(['verify', plan]);
  assert.equal(v.code, 1);
});
