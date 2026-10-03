import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, openSync, readFileSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.js');

// Note: piped stdio of spawned children is swallowed in this sandbox,
// so capture output via temp files instead of { encoding: 'utf8' }.
let captureDir;
function run(store, ...args) {
  captureDir ??= mkdtempSync(join(tmpdir(), 'planner-cap-'));
  const outPath = join(captureDir, `out-${process.hrtime.bigint()}.txt`);
  const errPath = join(captureDir, `err-${process.hrtime.bigint()}.txt`);
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  const r = spawnSync(process.execPath, [CLI, '--store', store, ...args], {
    stdio: ['ignore', outFd, errFd],
  });
  closeSync(outFd);
  closeSync(errFd);
  return { code: r.status, out: readFileSync(outPath, 'utf8'), err: readFileSync(errPath, 'utf8') };
}

function addJob(store, id, desc, m, e, cost, overdue) {
  return run(store, 'add', '--id', id, '--desc', desc, '--material', m, '--equipment', e,
    '--cost', String(cost), '--overdue', String(overdue));
}

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'planner-'));
  try {
    fn(join(dir, 's.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('acceptance 3: void excludes from select, restore brings it back, explain cites 倒排/扫描', () => {
  withStore((store) => {
    assert.equal(addJob(store, 'J1', '低温 固化 M-1 EQ-1', 'M-1', 'EQ-1', 10, 0).code, 0);
    assert.equal(addJob(store, 'J2', '低温 固化 M-2 EQ-2', 'M-2', 'EQ-2', 20, 0).code, 0);

    // equal score (10), k=1 -> min cost wins: J1
    let r = run(store, 'select', '--k', '1', '--budget', '100');
    assert.equal(r.code, 0);
    assert.match(r.out, /status: OK/);
    assert.match(r.out, /jobs=\[J1\]/);

    // void J1 -> excluded immediately
    assert.equal(run(store, 'void', '--id', 'J1').code, 0);
    r = run(store, 'select', '--k', '1', '--budget', '100');
    assert.match(r.out, /jobs=\[J2\]/);

    // restore -> back in
    assert.equal(run(store, 'restore', '--id', 'J1').code, 0);
    r = run(store, 'select', '--k', '1', '--budget', '100');
    assert.match(r.out, /jobs=\[J1\]/);

    // explain cites both sources and keeps audit of void/restore
    r = run(store, 'explain', '--id', 'J1');
    assert.equal(r.code, 0);
    assert.match(r.out, /倒排 inverted-index/);
    assert.match(r.out, /扫描 linear-scan/);
    assert.match(r.out, /matched=true/);
    assert.match(r.out, /score: 20/);
    assert.match(r.out, /#\d+ void J1/);
    assert.match(r.out, /#\d+ restore J1/);
  });
});

test('acceptance 4 via CLI: EMPTY and OVER_BUDGET are distinct statuses', () => {
  withStore((store) => {
    // no jobs at all -> EMPTY
    let r = run(store, 'select', '--k', '1', '--budget', '100');
    assert.equal(r.code, 0);
    assert.match(r.out, /status: EMPTY/);
    // non-matching job only -> still EMPTY
    addJob(store, 'X', '高温 固化 X-M X-E', 'X-M', 'X-E', 1, 0);
    r = run(store, 'select', '--k', '1', '--budget', '100');
    assert.match(r.out, /status: EMPTY/);
    // matching but unaffordable -> OVER_BUDGET
    addJob(store, 'Y', '低温 固化 Y-M Y-E', 'Y-M', 'Y-E', 50, 0);
    r = run(store, 'select', '--k', '2', '--budget', '49');
    assert.match(r.out, /status: OVER_BUDGET/);
    r = run(store, 'select', '--k', '2', '--budget', '50');
    assert.match(r.out, /status: OK/);
    assert.match(r.out, /jobs=\[Y\]/);
  });
});

test('E_TIE: --one fails on tied optima; default lists all ties', () => {
  withStore((store) => {
    addJob(store, 'J1', '低温 固化 M-1 EQ-1', 'M-1', 'EQ-1', 10, 0);
    addJob(store, 'J2', '低温 固化 M-2 EQ-2', 'M-2', 'EQ-2', 10, 0);
    let r = run(store, 'select', '--k', '1', '--budget', '100');
    assert.equal(r.code, 0);
    assert.match(r.out, /status: TIE/);
    assert.match(r.out, /jobs=\[J1\]/);
    assert.match(r.out, /jobs=\[J2\]/);
    r = run(store, 'select', '--k', '1', '--budget', '100', '--one');
    assert.equal(r.code, 1);
    assert.match(r.err, /^E_TIE:/);
  });
});

test('E_LIMIT and E_STATE surface on stderr with exit 1', () => {
  withStore((store) => {
    let r = run(store, 'select', '--k', '0', '--budget', '10');
    assert.equal(r.code, 1);
    assert.match(r.err, /^E_LIMIT:/);
    r = run(store, 'select', '--k', '1', '--budget', '-5');
    assert.match(r.err, /^E_LIMIT:/);
    r = run(store, 'void', '--id', 'GHOST');
    assert.equal(r.code, 1);
    assert.match(r.err, /^E_STATE:/);
    addJob(store, 'J1', '低温 固化 M-1 EQ-1', 'M-1', 'EQ-1', 10, 0);
    r = run(store, 'add', '--id', 'J1', '--desc', 'x', '--material', 'M', '--equipment', 'E', '--cost', '1', '--overdue', '0');
    assert.match(r.err, /^E_STATE:/);
    r = run(store, 'add', '--id', 'J2', '--desc', 'x', '--material', 'M', '--equipment', 'E', '--cost', 'abc', '--overdue', '0');
    assert.match(r.err, /^E_LIMIT:/);
  });
});
