'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'maint-cli-'));
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

const INPUT = {
  budget: 100,
  crews: 2,
  parts: { pump: 1 },
  tasks: [
    { id: 'A', downtime: 2, modes: [{ id: 'f', duration: 2, cost: 60, parts: { pump: 1 } }, { id: 's', duration: 5, cost: 10 }] },
    { id: 'B', deps: ['A'], downtime: 1, deferPenalty: 20, modes: [{ id: 'f', duration: 1, cost: 50 }, { id: 's', duration: 3, cost: 5 }] },
  ],
};

test('CLI produces full output for a command script', () => {
  const dir = tmpdir();
  const inputPath = path.join(dir, 'input.json');
  const commandsPath = path.join(dir, 'commands.json');
  const outPath = path.join(dir, 'out.json');
  fs.writeFileSync(inputPath, JSON.stringify(INPUT));
  fs.writeFileSync(commandsPath, JSON.stringify([
    { type: 'setBudget', budget: 15 },
    { type: 'undo' },
    { type: 'updateModeCost', taskId: 'B', modeId: 'f', cost: 5 },
  ]));
  const run = runCli(['maintenance', inputPath, commandsPath, '-o', outPath]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(out.initial.status, 'ok');
  assert.equal(out.steps.length, 3);
  assert.deepEqual(out.steps.map((s) => s.status), ['ok', 'ok', 'ok']);
  assert.equal(out.steps[1].command.type, 'undo');
  // Output contains intervals per crew, downtime, cost, critical constraints,
  // diffs and the optimality certificate.
  assert.ok(Array.isArray(out.final.crews));
  assert.equal(out.final.crews.length, 2);
  for (const crew of out.final.crews) {
    for (const iv of crew) {
      assert.ok(iv.end > iv.start);
    }
  }
  assert.equal(typeof out.final.objective.downtime, 'number');
  assert.equal(typeof out.final.objective.cost, 'number');
  assert.ok(out.final.criticalConstraints.budget);
  assert.ok(out.final.certificate.plansConsidered > 0);
  assert.ok(out.steps[0].diff.downtime);
  // undo restores the initial optimum.
  assert.deepEqual(out.steps[1].result.objective, out.initial.objective);
});

test('CLI is byte-for-byte reproducible across runs and key orderings', () => {
  const dir = tmpdir();
  const inputPath = path.join(dir, 'input.json');
  const commandsPath = path.join(dir, 'commands.json');
  fs.writeFileSync(inputPath, JSON.stringify(INPUT));
  fs.writeFileSync(commandsPath, JSON.stringify([{ type: 'setBudget', budget: 15 }]));
  const out1 = path.join(dir, 'o1.json');
  const out2 = path.join(dir, 'o2.json');
  assert.equal(runCli(['maintenance', inputPath, commandsPath, '-o', out1]).status, 0);
  assert.equal(runCli(['maintenance', inputPath, commandsPath, '-o', out2]).status, 0);
  assert.equal(fs.readFileSync(out1, 'utf8'), fs.readFileSync(out2, 'utf8'));

  // Same problem, different JSON key order -> identical result.
  const shuffled = {
    tasks: INPUT.tasks.map((t) => ({
      modes: t.modes.map((m) => ({ parts: m.parts, cost: m.cost, duration: m.duration, id: m.id })),
      downtime: t.downtime,
      deferPenalty: t.deferPenalty,
      deps: t.deps,
      id: t.id,
    })),
    parts: INPUT.parts,
    crews: INPUT.crews,
    budget: INPUT.budget,
  };
  const inputPath2 = path.join(dir, 'input2.json');
  const out3 = path.join(dir, 'o3.json');
  fs.writeFileSync(inputPath2, JSON.stringify(shuffled));
  assert.equal(runCli(['maintenance', inputPath2, commandsPath, '-o', out3]).status, 0);
  assert.equal(fs.readFileSync(out1, 'utf8'), fs.readFileSync(out3, 'utf8'));
});

test('CLI exits 2 with coded stderr on invalid input', () => {
  const dir = tmpdir();
  const inputPath = path.join(dir, 'input.json');
  const commandsPath = path.join(dir, 'commands.json');
  fs.writeFileSync(commandsPath, '[]');

  fs.writeFileSync(inputPath, JSON.stringify({ budget: -3, tasks: [] }));
  let run = runCli(['maintenance', inputPath, commandsPath]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /NEGATIVE_BUDGET/);

  fs.writeFileSync(inputPath, JSON.stringify({
    budget: 10,
    tasks: [
      { id: 'A', deps: ['B'], modes: [{ id: 'm', duration: 1, cost: 1 }] },
      { id: 'B', deps: ['A'], modes: [{ id: 'm', duration: 1, cost: 1 }] },
    ],
  }));
  run = runCli(['maintenance', inputPath, commandsPath]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /CYCLIC_DAG/);

  fs.writeFileSync(inputPath, JSON.stringify({
    budget: 10,
    tasks: [{ id: 'A', modes: [{ id: 'm', duration: 1, cost: 1, parts: { flux: 1 } }] }],
  }));
  run = runCli(['maintenance', inputPath, commandsPath]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /UNKNOWN_PART/);
});

test('CLI records command errors in the output and stops', () => {
  const dir = tmpdir();
  const inputPath = path.join(dir, 'input.json');
  const commandsPath = path.join(dir, 'commands.json');
  const outPath = path.join(dir, 'out.json');
  fs.writeFileSync(inputPath, JSON.stringify(INPUT));
  fs.writeFileSync(commandsPath, JSON.stringify([
    { type: 'setBudget', budget: 50 },
    { type: 'setBudget', budget: -10 },
    { type: 'setBudget', budget: 999 },
  ]));
  const run = runCli(['maintenance', inputPath, commandsPath, '-o', outPath]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /NEGATIVE_BUDGET/);
  const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(out.steps.length, 2);
  assert.equal(out.steps[0].status, 'ok');
  assert.equal(out.steps[1].status, 'error');
  assert.equal(out.steps[1].error.code, 'NEGATIVE_BUDGET');
  // State stays at the last successful command.
  assert.equal(out.final.budget.limit, 50);
});

test('CLI usage errors exit 1', () => {
  assert.equal(runCli([]).status, 1);
  assert.equal(runCli(['bogus']).status, 1);
  const run = runCli(['maintenance', '/nonexistent.json', '/also-missing.json']);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /IO_ERROR/);
});
