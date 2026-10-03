'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli.js');

// Runs the real CLI as a subprocess. stdout/stderr are redirected through the
// shell to files so the test works in sandboxes where piped stdio of
// grandchild processes is restricted.
function run(args, options = {}) {
  const dir = options.dir;
  const stdoutFile = path.join(dir, 'stdout.txt');
  const stderrFile = path.join(dir, 'stderr.txt');
  const statusFile = path.join(dir, 'status.txt');
  const quoted = [process.execPath, CLI, ...args]
    .map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`)
    .join(' ');
  const redirect = options.stdinFile ? `< '${options.stdinFile}'` : '';
  const command = `${quoted} ${redirect} > '${stdoutFile}' 2> '${stderrFile}'; echo $? > '${statusFile}'`;
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', `cd '${dir}' && ${command}`]);
    child.on('error', reject);
    child.on('close', () => {
      resolve({
        status: Number(fs.readFileSync(statusFile, 'utf8').trim()),
        stdout: fs.readFileSync(stdoutFile, 'utf8'),
        stderr: fs.readFileSync(stderrFile, 'utf8'),
      });
    });
  });
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cli-'));
}

function writeJSON(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function scheduleMap(output) {
  return Object.fromEntries(output.schedule.map((op) => [op.id, op.start]));
}

test('CLI: schedule/apply/undo/redo exit codes and outputs', async () => {
  const dir = tmpdir();
  const state = path.join(dir, 'state.json');
  const problem = writeJSON(dir, 'problem.json', {
    tasks: [
      { id: 'a', line: 'L1', duration: 2, release: null, due: 6 },
      { id: 'b', line: 'L1', duration: 2, release: null, due: 6 },
    ],
    capacity: { L1: { '*': 2 } },
  });

  let res = await run(['schedule', problem, '--state', state], { dir });
  assert.equal(res.status, 0, res.stderr);
  const scheduled = JSON.parse(res.stdout);
  assert.equal(scheduled.feasible, true);
  assert.deepEqual(scheduleMap(scheduled), { a: 0, b: 0 });
  assert.ok(fs.existsSync(state), 'state file persisted');

  const cut = writeJSON(dir, 'cut.json', { op: 'setCapacity', line: 'L1', slot: null, capacity: 1 });
  res = await run(['apply', cut, '--state', state], { dir });
  assert.equal(res.status, 0, res.stderr);
  const applied = JSON.parse(res.stdout);
  assert.deepEqual(scheduleMap(applied), { a: 0, b: 2 });
  assert.deepEqual(applied.affectedOps, ['a', 'b']);
  assert.equal(applied.undoDepth, 1);

  res = await run(['undo', '--state', state], { dir });
  assert.equal(res.status, 0, res.stderr);
  const undone = JSON.parse(res.stdout);
  assert.deepEqual(scheduleMap(undone), { a: 0, b: 0 });
  assert.equal(undone.redoDepth, 1);

  res = await run(['redo', '--state', state], { dir });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(scheduleMap(JSON.parse(res.stdout)), { a: 0, b: 2 });
});

test('CLI: infeasible problem exits 1 and prints a certificate', async () => {
  const dir = tmpdir();
  const state = path.join(dir, 'state.json');
  const problem = writeJSON(dir, 'problem.json', {
    tasks: [
      { id: 'a', line: 'L1', duration: 2, release: 0, due: 2 },
      { id: 'b', line: 'L1', duration: 2, release: 0, due: 2 },
    ],
  });
  const res = await run(['schedule', problem, '--state', state], { dir });
  assert.equal(res.status, 1, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.feasible, false);
  assert.equal(out.certificate.kind, 'minimalInfeasibleSubset');
  assert.deepEqual(out.certificate.tasks.map((t) => t.id).sort(), ['a', 'b']);
});

test('CLI: errors exit 2', async () => {
  const dir = tmpdir();
  const state = path.join(dir, 'state.json');
  assert.equal((await run(['undo', '--state', state], { dir })).status, 2, 'undo without state');
  assert.equal((await run(['bogus'], { dir })).status, 2, 'unknown command');
  const bad = writeJSON(dir, 'bad.json', { tasks: [{ id: 'a' }] });
  assert.equal((await run(['schedule', bad, '--state', state], { dir })).status, 2, 'invalid problem');
});

test('CLI: reads problem from stdin with -', async () => {
  const dir = tmpdir();
  const state = path.join(dir, 'state.json');
  const input = writeJSON(dir, 'input.json', {
    tasks: [{ id: 'a', line: 'L1', duration: 1, release: null, due: null }],
  });
  const res = await run(['schedule', '-', '--state', state], { dir, stdinFile: input });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).feasible, true);
});
