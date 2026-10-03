import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Interpreter } from '../src/interp.js';
import { Model, schedule, buildWindows, subtract, maintenanceOf } from '../src/model.js';
import { runPlan } from '../testlib/cli.js';

const BASE = `
  line L1, L2;
  calendar main { shift mon..fri 08:00-16:00; }
  constraint overlap(L1) <= 1 and overlap(L2) <= 1;
`;

test('feasible plan with tied priorities is deterministic (acceptance 1)', () => {
  const src = `
    ${BASE}
    job JA { line: L1; duration: 2h; priority: 2; }
    job JB { line: L1; duration: 2h; priority: 2; }
    job JC { line: L1; duration: 1h; priority: 2; }
    job JZ { line: L2; duration: 1h; priority: 5; }
  `;
  const run = () => {
    const interp = new Interpreter(new Model());
    interp.runSource(src);
    return schedule(interp.model);
  };
  const a = run();
  const b = run();
  assert.ok(a, 'expected a feasible plan');
  assert.deepEqual(a, b, 'scheduling must be deterministic');
  // Tied priorities are ordered by name: JA before JB before JC.
  assert.ok(a.get('JA').start < a.get('JB').start);
  assert.ok(a.get('JB').start < a.get('JC').start);
  // Higher priority job on L2 starts at the first window.
  assert.equal(a.get('JZ').start, a.get('JA').start);
  // No overlap on L1.
  const ivs = ['JA', 'JB', 'JC'].map((n) => a.get(n)).sort((x, y) => x.start - y.start);
  for (let k = 1; k < ivs.length; k++) assert.ok(ivs[k].start >= ivs[k - 1].end);
});

test('jobs avoid maintenance windows and respect precedence', () => {
  const interp = new Interpreter(new Model());
  interp.runSource(`
    ${BASE}
    maintenance L1 @2026-01-05T10:00 for 2h;
    job J1 { line: L1; duration: 2h; priority: 1; }
    job J2 { line: L1; duration: 2h; priority: 1; after: J1; }
  `);
  const placed = schedule(interp.model);
  assert.ok(placed);
  const p1 = placed.get('J1');
  // J1 is 2h; the 08:00-10:00 slot fits exactly before maintenance.
  assert.equal(p1.start, buildWindows(interp.model)[0][0]);
  assert.equal(p1.end, p1.start + 120);
  const p2 = placed.get('J2');
  assert.ok(p2.start >= p1.end, 'precedence respected');
  const free = subtract(buildWindows(interp.model), maintenanceOf(interp.model, 0));
  for (const p of [p1, p2]) {
    assert.ok(free.some(([s, e]) => p.start >= s && p.end <= e), 'job inside free window');
  }
});

test('infeasible model returns null (dependency cycle)', () => {
  const interp = new Interpreter(new Model());
  interp.runSource(`
    ${BASE}
    job J1 { line: L1; duration: 1h; after: J2; }
    job J2 { line: L1; duration: 1h; after: J1; }
  `);
  assert.equal(schedule(interp.model), null);
});

test('CLI: feasible apply prints JSON schedule, infeasible prints INFEASIBLE with exit 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-sched-'));
  assert.equal(runPlan(['init', dir]).code, 0);

  const okScript = path.join(dir, 'ok.plan');
  fs.writeFileSync(okScript, `${BASE}
    job J1 { line: L1; duration: 1h; priority: 1; }
    commit;
  `);
  const ok = runPlan(['apply', dir, okScript]);
  assert.equal(ok.code, 0, ok.stderr);
  const plan = JSON.parse(ok.stdout);
  assert.equal(plan.feasible, true);
  assert.equal(plan.jobs.length, 1);

  const badScript = path.join(dir, 'bad.plan');
  fs.writeFileSync(badScript, `
    constraint total(L1) <= 90m;
    add-job J2 { line: L1; duration: 2h; priority: 1; };
    commit;
  `);
  const bad = runPlan(['apply', dir, badScript]);
  assert.equal(bad.code, 2);
  assert.match(bad.stdout, /^INFEASIBLE/m);

  // The infeasible transaction was not persisted.
  const exp = runPlan(['export', dir]);
  assert.equal(exp.code, 0);
  assert.equal(JSON.parse(exp.stdout).jobs.length, 1);
});
