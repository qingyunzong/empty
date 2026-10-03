import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadScenario, runScenario } from '../src/scenario.js';
import { checkOrderIndependence } from '../src/enumerate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('CLI run: 乱序事件场景输出时间线/配额/冲正/拒绝', () => {
  const report = runScenario(loadScenario(join(root, 'examples', 'scenario.json')));
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['applied', 'applied', 'applied'],
  );
  // Emergency V2 preempts V1; V1 resumes before V3 thanks to aging.
  assert.deepEqual(
    report.timeline.map((s) => [s.vehicleId, s.reason]),
    [
      ['V1', 'preempted'],
      ['V2', 'completed'],
      ['V1', 'completed'],
      ['V3', 'completed'],
    ],
  );
  assert.ok(Array.isArray(report.quotas.tenants));
  assert.ok(Array.isArray(report.reversals));
  assert.ok(Array.isArray(report.rejections));
});

test('CLI run: 结算场景产生冲正证书并拒绝 cutoff 后迟到事件', () => {
  const report = runScenario(loadScenario(join(root, 'examples', 'settlement.json')));
  assert.deepEqual(
    report.steps.map((s) => s.status ?? s.op),
    ['applied', 'settle', 'applied', 'rejected'],
  );
  assert.equal(report.reversals.length, 1);
  assert.equal(report.reversals[0].diffs[0].deltaMinutes, 30);
  assert.equal(report.rejections.length, 1);
  assert.equal(report.rejections[0].reason, 'arrived-after-cutoff');
});

test('CLI enumerate: 全排列归并一致', () => {
  const scenario = loadScenario(join(root, 'examples', 'scenario.json'));
  const result = checkOrderIndependence(scenario.config, scenario.events);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 6); // 3 events -> 3! orderings
});
