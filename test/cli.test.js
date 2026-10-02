import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.js');
const RESULTS_FILE = join(import.meta.dirname, '..', 'test-results.txt');
const records = [];

function runCli(args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      const res = { status: code, stdout, stderr };
      records.push({
        label,
        command: `node src/cli.js ${args.join(' ')}`,
        exitCode: code,
        stdout,
        stderr,
      });
      resolve(res);
    });
  });
}

after(() => {
  const chunks = [
    '# maintenance-scheduler acceptance results',
    `# recorded by test/cli.test.js under node ${process.version}`,
    '# each block shows the real exit code, stdout and stderr of a CLI run',
    '',
  ];
  for (const r of records) {
    chunks.push(`== case: ${r.label} ==`);
    chunks.push(`command: ${r.command}`);
    chunks.push(`exit code: ${r.exitCode}`);
    chunks.push('--- stdout ---');
    chunks.push(r.stdout.replace(/\n$/, ''));
    chunks.push('--- stderr ---');
    chunks.push(r.stderr.replace(/\n$/, ''));
    chunks.push('');
  }
  writeFileSync(RESULTS_FILE, chunks.join('\n') + '\n');
});

function makeWorkspace() {
  return mkdtempSync(join(tmpdir(), 'maint-cli-'));
}

function writeJson(dir, name, obj) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

const validInput = {
  budget: 30,
  crews: 2,
  parts: { valve: 2 },
  tasks: [
    { id: 'A', modes: [{ duration: 4, cost: 3, parts: { valve: 1 } }, { duration: 2, cost: 8 }] },
    { id: 'B', deps: ['A'], modes: [{ duration: 3, cost: 4 }, { duration: 1, cost: 9 }] },
    { id: 'C', modes: [{ duration: 5, cost: 2 }, { duration: 3, cost: 6 }] },
    { id: 'D', deps: ['B', 'C'], modes: [{ duration: 2, cost: 5, parts: { valve: 1 } }] },
  ],
};

test('valid run: exit 0, out.json has intervals, diff and certificate', async () => {
  const dir = makeWorkspace();
  try {
    const input = writeJson(dir, 'input.json', validInput);
    const commands = writeJson(dir, 'commands.json', [
      { op: 'setBudget', budget: 14 },
      { op: 'undo' },
      { op: 'redo' },
    ]);
    const out = join(dir, 'out.json');
    const res = await runCli(['maintenance', input, commands, '-o', out], 'valid-run');
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(report.problem, 'maintenance');
    assert.equal(report.steps.length, 4);
    const step0 = report.steps[0];
    assert.equal(step0.status, 'optimal');
    assert.equal(step0.schedule.crews.length, 2, 'two crews');
    // non-preemptive intervals: one contiguous [start,end) per task
    const ids = step0.schedule.intervals.map((i) => i.task).sort();
    assert.deepEqual(ids, ['A', 'B', 'C', 'D']);
    for (const iv of step0.schedule.intervals) {
      assert.ok(iv.end === iv.start + iv.duration, 'non-preemptive interval');
    }
    assert.ok(step0.certificate.method === 'exact-branch-and-bound');
    assert.ok('diff' in step0);
    assert.ok('criticalConstraints' in step0);
    // undo/redo round trip reproduces identical schedules
    assert.deepEqual(report.steps[1].schedule, report.steps[3].schedule);
    assert.deepEqual(report.steps[0].schedule, report.steps[2].schedule);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('budget cut via CLI: plan change and successor invalidation visible in diff', async () => {
  const dir = makeWorkspace();
  try {
    const input = writeJson(dir, 'input.json', {
      budget: 30,
      tasks: [
        { id: 'A', modes: [{ duration: 4, cost: 2 }, { duration: 1, cost: 10 }] },
        { id: 'B', deps: ['A'], modes: [{ duration: 4, cost: 2 }, { duration: 1, cost: 10 }] },
        { id: 'C', deps: ['B'], modes: [{ duration: 4, cost: 2 }, { duration: 1, cost: 10 }] },
      ],
    });
    const commands = writeJson(dir, 'commands.json', [{ op: 'setBudget', budget: 6 }]);
    const out = join(dir, 'out.json');
    const res = await runCli(['maintenance', input, commands, '-o', out], 'budget-cut');
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    const step = report.steps[1];
    assert.equal(step.status, 'optimal');
    assert.ok(step.schedule.cost <= 6);
    assert.ok(step.diff.downtimeDelta > 0);
    const moved = step.diff.intervalsChanged.map((c) => c.task).sort();
    assert.deepEqual(moved, ['A', 'B', 'C'], 'mode change upstream invalidates all successors');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cyclic DAG input: exit 1 with CYCLIC_DAG on stderr', async () => {
  const dir = makeWorkspace();
  try {
    const input = writeJson(dir, 'input.json', {
      budget: 10,
      tasks: [
        { id: 'A', deps: ['B'], modes: [{ duration: 1, cost: 1 }] },
        { id: 'B', deps: ['A'], modes: [{ duration: 1, cost: 1 }] },
      ],
    });
    const commands = writeJson(dir, 'commands.json', []);
    const res = await runCli(['maintenance', input, commands], 'cyclic-dag');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /CYCLIC_DAG/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('negative budget input: exit 1 with NEGATIVE_BUDGET on stderr', async () => {
  const dir = makeWorkspace();
  try {
    const input = writeJson(dir, 'input.json', { budget: -3, tasks: [] });
    const commands = writeJson(dir, 'commands.json', []);
    const res = await runCli(['maintenance', input, commands], 'negative-budget');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /NEGATIVE_BUDGET/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown spare part in input: exit 1 with UNKNOWN_PART on stderr', async () => {
  const dir = makeWorkspace();
  try {
    const input = writeJson(dir, 'input.json', {
      budget: 10,
      parts: { valve: 1 },
      tasks: [{ id: 'A', modes: [{ duration: 1, cost: 1, parts: { flux: 1 } }] }],
    });
    const commands = writeJson(dir, 'commands.json', []);
    const res = await runCli(['maintenance', input, commands], 'unknown-part');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /UNKNOWN_PART/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('command-level error is in-band and does not abort the stream', async () => {
  const dir = makeWorkspace();
  try {
    const input = writeJson(dir, 'input.json', validInput);
    const commands = writeJson(dir, 'commands.json', [
      { op: 'addTask', task: { id: 'E', modes: [{ duration: 1, cost: 1, parts: { ghost: 1 } }] } },
      { op: 'setBudget', budget: 40 },
    ]);
    const out = join(dir, 'out.json');
    const res = await runCli(['maintenance', input, commands, '-o', out], 'command-error-in-band');
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(report.steps[1].status, 'error');
    assert.equal(report.steps[1].error.code, 'UNKNOWN_PART');
    assert.equal(report.steps[2].status, 'optimal', 'stream continues after the bad command');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('usage error: exit 2', async () => {
  const res = await runCli(['maintenance'], 'usage-error');
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage:/);
});
