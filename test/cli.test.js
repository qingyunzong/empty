import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';

function run(args) {
  const stdout = [];
  const stderr = [];
  const status = main(args, {
    out: (s) => stdout.push(s),
    err: (s) => stderr.push(s),
    writeOut: (s) => stdout.push(s),
  });
  return { status, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function setup(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'energy-cli-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const at = (dir, name) => path.join(dir, name);

const OK_DSL = `
site S {
  slots 4
  slotMinutes 15
  tariff 1
  carbon 0.5
  costBudget 10
  task a { power 4 kW duration 15 min window 00:00 .. 01:00 }
}
`;

test('schedule writes a plan and exits 0; verify accepts it', () => {
  const dir = setup({ 'site.dsl': OK_DSL });
  const r = run(['schedule', at(dir, 'site.dsl'), '--json', at(dir, 'plan.json')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK cost=1/);
  const plan = JSON.parse(readFileSync(at(dir, 'plan.json'), 'utf8'));
  assert.equal(plan.sites[0].status, 'OK');
  assert.equal(plan.sites[0].optimum.cost, 1);
  assert.equal(plan.sites[0].optimum.assignments.length, 1);

  const v = run(['verify', at(dir, 'plan.json')]);
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /VALID/);
});

test('syntax error exits 2 and reports file:line:col', () => {
  const dir = setup({ 'bad.dsl': 'site S {\n  slots 4\n  tariff 1\n  task a { power 4 kW\n}\n' });
  const r = run(['schedule', at(dir, 'bad.dsl')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bad\.dsl:6:1: error:/);
});

test('type error exits 2 and reports line and column', () => {
  const dir = setup({
    'bad.dsl': 'site S {\n  slots 4\n  tariff 1\n  task a {\n    power 4 kWh\n    duration 15 min\n  }\n}\n',
  });
  const r = run(['schedule', at(dir, 'bad.dsl')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bad\.dsl:5:11: error: type error: 'power'/);
});

test('INFEASIBLE exits 3 and records status in the plan', () => {
  const dir = setup({
    'site.dsl': `
site S {
  slots 4
  slotMinutes 15
  tariff 1
  maintenance 00:00 .. 01:00
  task a { power 1 kW duration 15 min window 00:00 .. 01:00 }
}
`,
  });
  const r = run(['schedule', at(dir, 'site.dsl'), '--json', at(dir, 'plan.json')]);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /INFEASIBLE/);
  const plan = JSON.parse(readFileSync(at(dir, 'plan.json'), 'utf8'));
  assert.equal(plan.sites[0].status, 'INFEASIBLE');
  assert.equal(plan.sites[0].optimum, null);
});

test('OVER_BUDGET exits 4 and lists the minimum cost', () => {
  const dir = setup({
    'site.dsl': `
site S {
  slots 4
  slotMinutes 15
  tariff 1
  costBudget 3
  task a { power 4 kW duration 60 min window 00:00 .. 01:00 }
}
`,
  });
  const r = run(['schedule', at(dir, 'site.dsl'), '--json', at(dir, 'plan.json')]);
  assert.equal(r.status, 4);
  assert.match(r.stdout, /OVER_BUDGET/);
  assert.match(r.stdout, /minimum cost 4/);
  const plan = JSON.parse(readFileSync(at(dir, 'plan.json'), 'utf8'));
  assert.equal(plan.sites[0].status, 'OVER_BUDGET');
  assert.deepEqual(plan.sites[0].budgetsExceeded, ['cost']);
  assert.equal(plan.sites[0].optimum.cost, 4);
});

test('verify rejects a tampered plan with exit 1', () => {
  const dir = setup({ 'site.dsl': OK_DSL });
  assert.equal(run(['schedule', at(dir, 'site.dsl'), '--json', at(dir, 'plan.json')]).status, 0);
  const planPath = at(dir, 'plan.json');
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  plan.sites[0].optimum.costNum = '1';
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  const v = run(['verify', planPath]);
  assert.equal(v.status, 1);
  assert.match(v.stderr, /INVALID/);
});

test('verify rejects a plan that violates hard constraints', () => {
  const dir = setup({ 'site.dsl': OK_DSL });
  assert.equal(run(['schedule', at(dir, 'site.dsl'), '--json', at(dir, 'plan.json')]).status, 0);
  const planPath = at(dir, 'plan.json');
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  plan.sites[0].optimum.assignments[0].slots = [3, 3, 3, 3];
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  const v = run(['verify', planPath]);
  assert.equal(v.status, 1);
});

test('missing input file exits 2', () => {
  const dir = setup({});
  const r = run(['schedule', at(dir, 'nope.dsl')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot read file/);
});

test('no arguments prints usage and exits 2', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});

test('schedule without --json prints the plan to stdout', () => {
  const dir = setup({ 'site.dsl': OK_DSL });
  const r = run(['schedule', at(dir, 'site.dsl')]);
  assert.equal(r.status, 0);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.sites[0].status, 'OK');
  assert.ok(!existsSync(at(dir, 'plan.json')));
});
