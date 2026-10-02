import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// Note: this sandboxed environment swallows piped stdout of nested node
// processes, so the CLI is exercised through its --out file channel and its
// exit code, both of which are real process behavior.
function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}

function writeJson(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

const SCENARIO = {
  config: { capacity: 10, runDuration: 60, cleanoutTime: 30, dayLength: 480 },
  recipes: [{ id: 'A', family: 'F1', dailyQuota: 100 }],
  orders: [
    { id: 'n1', recipe: 'A', qty: 10, due: 1000 },
    { id: 'n2', recipe: 'A', qty: 10, due: 1000 },
  ],
};

test('CLI plan -> update chain emits runs, quota, freeze boundary and diff', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'furnace-'));
  const scenarioPath = writeJson(dir, 'scenario.json', SCENARIO);
  const planPath = join(dir, 'plan.json');
  const plan2Path = join(dir, 'plan2.json');

  assert.equal(await runCli(['plan', scenarioPath, '--out', planPath]), 0);
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  assert.equal(plan.status, 'ok');
  assert.equal(plan.runs.length, 2);
  assert.ok(Array.isArray(plan.quotaUsage));
  assert.deepEqual(plan.freezeBoundary, { freezeTime: 0, frozenRunIds: [] });

  const eventsPath = writeJson(dir, 'events.json', {
    freezeTime: 60,
    addOrders: [{ id: 'u1', recipe: 'A', qty: 10, due: 70, priority: 'urgent' }],
  });
  assert.equal(await runCli(['update', planPath, eventsPath, '--out', plan2Path]), 0);
  const plan2 = JSON.parse(readFileSync(plan2Path, 'utf8'));
  assert.equal(plan2.status, 'ok');
  assert.deepEqual(plan2.freezeBoundary.frozenRunIds, [1]);
  assert.deepEqual(plan2.diff.removedRunIds, [2]);
  assert.deepEqual(plan2.diff.addedRunIds, [3, 4]);
  assert.equal(plan2.runs[1].loads[0].orderId, 'u1');

  t.diagnostic(`cli update diff: ${JSON.stringify(plan2.diff)}`);
});

test('CLI compare reports heuristic vs enumerated optimum', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'furnace-'));
  const scenarioPath = writeJson(dir, 'scenario.json', {
    config: { capacity: 4, runDuration: 60, cleanoutTime: 30, dayLength: 480 },
    recipes: [
      { id: 'A', family: 'F1', dailyQuota: 100 },
      { id: 'B', family: 'F2', dailyQuota: 100 },
    ],
    orders: [
      { id: 'a1', recipe: 'A', qty: 4, due: 100 },
      { id: 'a2', recipe: 'A', qty: 4, due: 100 },
      { id: 'b1', recipe: 'B', qty: 4, due: 100 },
    ],
  });
  const reportPath = join(dir, 'compare.json');
  assert.equal(await runCli(['compare', scenarioPath, '--out', reportPath]), 0);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(report.optimal.total, 160);
  assert.equal(report.heuristic.total, 160);
  t.diagnostic(`cli compare: heuristic=${report.heuristic.total} optimal=${report.optimal.total}`);
});

test('CLI exits non-zero on infeasible scenario', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'furnace-'));
  const scenarioPath = writeJson(dir, 'scenario.json', {
    config: { capacity: 10 },
    recipes: [{ id: 'A', family: 'F1', dailyQuota: 100 }],
    orders: [{ id: 'big', recipe: 'A', qty: 12, splittable: false }],
  });
  const reportPath = join(dir, 'failed.json');
  const code = await runCli(['plan', scenarioPath, '--out', reportPath]);
  assert.equal(code, 1);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(report.status, 'failed');
  assert.ok(report.reasons.some((r) => r.includes('exceeds furnace capacity')));
  t.diagnostic(`cli failure path: exit=${code} reason=${report.reasons[0]}`);
});
