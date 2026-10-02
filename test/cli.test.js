'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tmpdir, cleanup } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'lineage.js');

// NOTE: in this sandbox, node child processes lose stdout when writing to
// pipes, so capture via temp files instead of spawnSync's pipe encoding.
function cli(args) {
  const outPath = path.join(os.tmpdir(), `lineage-cli-${process.pid}-${Math.random().toString(36).slice(2)}.out`);
  const errPath = `${outPath}.err`;
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, [BIN, ...args], { stdio: ['ignore', outFd, errFd] });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const stdout = fs.readFileSync(outPath, 'utf8');
  const stderr = fs.readFileSync(errPath, 'utf8');
  fs.rmSync(outPath, { force: true });
  fs.rmSync(errPath, { force: true });
  return { status: r.status, stdout, stderr };
}

function cliOk(args) {
  const r = cli(args);
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('CLI end-to-end: schedule, invalidation set and state root in output', () => {
  const dir = tmpdir();
  try {
    const init = cliOk(['init', '--cpus', '2', '--mem', '8', '--quota', 'a=100', '--state', dir]);
    assert.strictEqual(typeof init.stateRoot, 'string');

    cliOk(['submit', 'raw', '--cpu', '1', '--mem', '1', '--bytes', '10', '--cost', '2', '--owner', 'a', '--state', dir]);
    cliOk(['submit', 'der', '--cpu', '1', '--mem', '1', '--bytes', '5', '--cost', '1', '--owner', 'a', '--deps', 'raw', '--state', dir]);

    const sched = cliOk(['schedule', '--state', dir]);
    assert.deepStrictEqual(sched.completed, ['der', 'raw']);
    assert.ok(sched.schedule.some((e) => e.type === 'start' && e.node === 'raw'));
    assert.strictEqual(typeof sched.stateRoot, 'string');

    const commit = cliOk(['commit', '--state', dir]);
    assert.strictEqual(commit.generation, 1);
    assert.strictEqual(commit.root, sched.stateRoot, 'committed root matches scheduled state');

    const inv = cliOk(['invalidate', 'raw', '--state', dir]);
    assert.deepStrictEqual(inv.invalidated, ['der', 'raw']);

    const st = cliOk(['status', '--state', dir]);
    assert.strictEqual(st.nodes.der.status, 'pending');
    assert.strictEqual(st.root, inv.stateRoot);
  } finally {
    cleanup(dir);
  }
});

test('CLI exit 7: cycle, oversize resource, duplicate submit, duplicate commit', () => {
  const dir = tmpdir();
  try {
    cliOk(['init', '--cpus', '2', '--mem', '8', '--state', dir]);

    let r = cli(['submit', 'a', '--deps', 'a', '--state', dir]);
    assert.strictEqual(r.status, 7);
    assert.match(r.stderr, /CYCLE/);

    r = cli(['submit', 'big', '--cpu', '99', '--state', dir]);
    assert.strictEqual(r.status, 7);
    assert.match(r.stderr, /RESOURCE_EXCEEDED/);

    cliOk(['submit', 'x', '--state', dir]);
    r = cli(['submit', 'x', '--state', dir]);
    assert.strictEqual(r.status, 7);
    assert.match(r.stderr, /DUPLICATE/);

    cliOk(['commit', '--state', dir]);
    r = cli(['commit', '--state', dir]);
    assert.strictEqual(r.status, 7);
    assert.match(r.stderr, /DUPLICATE_COMMIT/);

    // Cycle introduced via correct (deps must exist at submit time).
    cliOk(['submit', 'y', '--deps', 'x', '--state', dir]);
    r = cli(['correct', 'x', '--deps', 'y', '--state', dir]);
    assert.strictEqual(r.status, 7);
    assert.match(r.stderr, /CYCLE/);
  } finally {
    cleanup(dir);
  }
});
