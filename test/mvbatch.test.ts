import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.js');

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'mvbatch-'));
}

function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function write(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

function read(dir: string, name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}

function names(dir: string): string[] {
  return readdirSync(dir).sort();
}

/** Contents of every real file in the dir (staging temps included, journal excluded). */
function liveContents(dir: string): string[] {
  return names(dir)
    .filter((n) => !n.startsWith('.mvbatch-journal'))
    .map((n) => read(dir, n))
    .sort();
}

test('simple batch rename', () => {
  const dir = tmp();
  write(dir, 'a', 'A');
  write(dir, 'b', 'B');
  const r = run(['a', 'x', 'b', 'y'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir, 'x'), 'A');
  assert.equal(read(dir, 'y'), 'B');
  assert.deepEqual(names(dir), ['x', 'y']);
});

test('swap two files', () => {
  const dir = tmp();
  write(dir, 'a', 'A');
  write(dir, 'b', 'B');
  const r = run(['a', 'b', 'b', 'a'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir, 'a'), 'B');
  assert.equal(read(dir, 'b'), 'A');
});

test('cyclic rename of four files', () => {
  const dir = tmp();
  for (const f of ['a', 'b', 'c', 'd']) write(dir, f, `content-${f}`);
  const r = run(['a', 'b', 'b', 'c', 'c', 'd', 'd', 'a'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir, 'b'), 'content-a');
  assert.equal(read(dir, 'c'), 'content-b');
  assert.equal(read(dir, 'd'), 'content-c');
  assert.equal(read(dir, 'a'), 'content-d');
  assert.deepEqual(names(dir), ['a', 'b', 'c', 'd']);
});

test('rejects an existing external target before touching anything', () => {
  const dir = tmp();
  write(dir, 'a', 'A');
  write(dir, 'x', 'X');
  const r = run(['a', 'x'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /target already exists/);
  assert.equal(read(dir, 'a'), 'A');
  assert.equal(read(dir, 'x'), 'X');
  assert.deepEqual(names(dir), ['a', 'x']);
});

test('rejects a missing source before touching anything', () => {
  const dir = tmp();
  write(dir, 'a', 'A');
  const r = run(['a', 'b', 'ghost', 'c'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /source does not exist/);
  assert.deepEqual(names(dir), ['a']);
});

test('rejects duplicate targets', () => {
  const dir = tmp();
  write(dir, 'a', 'A');
  write(dir, 'b', 'B');
  const r = run(['a', 'z', 'b', 'z'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /duplicate target/);
  assert.deepEqual(names(dir), ['a', 'b']);
});

test('fault injection at every rename step: no loss, resume completes the same batch', () => {
  const files = ['a', 'b', 'c', 'd'];
  const cycle = ['b', 'c', 'd', 'a'];
  const args = ['a', 'b', 'b', 'c', 'c', 'd', 'd', 'a'];
  const totalSteps = files.length * 2; // N staging renames + N commit renames
  for (let k = 1; k <= totalSteps; k++) {
    const dir = tmp();
    for (const f of files) write(dir, f, `content-${f}`);
    const crash = run(args, dir, { MVBATCH_FAIL_AT: String(k) });
    assert.equal(crash.status, 75, `step ${k}: ${crash.stderr}`);
    // Power loss must never lose data: every original content is still on disk.
    assert.deepEqual(liveContents(dir), files.map((f) => `content-${f}`).sort(), `step ${k}`);
    const done = run(['--resume'], dir);
    assert.equal(done.status, 0, `resume after step ${k}: ${done.stderr}`);
    for (let i = 0; i < files.length; i++) {
      assert.equal(read(dir, cycle[i]), `content-${files[i]}`, `step ${k}`);
    }
    assert.deepEqual(names(dir), files.slice().sort(), `step ${k}: no journal/temp left`);
  }
  // A crash scheduled past the last step never fires; the batch just succeeds.
  const dir = tmp();
  for (const f of files) write(dir, f, `content-${f}`);
  assert.equal(run(args, dir, { MVBATCH_FAIL_AT: String(totalSteps + 1) }).status, 0);
});

test('external rename conflict at a pending target halts the resume', () => {
  const dir = tmp();
  write(dir, 'a', 'A');
  write(dir, 'b', 'B');
  write(dir, 'c', 'C');
  // 3-cycle; crash right before the first commit rename (step 4).
  const crash = run(['a', 'b', 'b', 'c', 'c', 'a'], dir, { MVBATCH_FAIL_AT: '4' });
  assert.equal(crash.status, 75);
  // Someone else creates a file where the batch wants to commit.
  write(dir, 'b', 'INTRUDER');
  const r = run(['--resume'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /foreign file|conflict/i);
  // Halted without loss: batch contents and the intruder are all intact.
  assert.deepEqual(liveContents(dir), ['A', 'B', 'C', 'INTRUDER'].sort());
});

test('external rename of a staged file halts the resume with an identity error', () => {
  const dir = tmp();
  write(dir, 'a', 'A');
  write(dir, 'b', 'B');
  // Swap; crash after both files are staged, before the first commit.
  const crash = run(['a', 'b', 'b', 'a'], dir, { MVBATCH_FAIL_AT: '3' });
  assert.equal(crash.status, 75);
  const staged = names(dir).find((n) => n.startsWith('.mvbatch-tmp'));
  assert.ok(staged);
  renameSync(join(dir, staged!), join(dir, 'stolen'));
  const r = run(['--resume'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lost|identity|vanished/i);
  // The remaining tracked content is untouched.
  assert.ok(liveContents(dir).includes('A') || liveContents(dir).includes('B'));
});

test('symlinks are renamed themselves, never followed', () => {
  const dir = tmp();
  write(dir, 'real1', 'R1');
  write(dir, 'real2', 'R2');
  symlinkSync('real1', join(dir, 'link1'));
  symlinkSync('real2', join(dir, 'link2'));
  symlinkSync('nonexistent-target', join(dir, 'dangling'));
  const r = run(['link1', 'link2', 'link2', 'link1', 'dangling', 'moved'], dir);
  assert.equal(r.status, 0, r.stderr);
  // The links swapped targets; the real files were never touched.
  assert.ok(lstatSync(join(dir, 'link1')).isSymbolicLink());
  assert.ok(lstatSync(join(dir, 'link2')).isSymbolicLink());
  assert.equal(readlinkSync(join(dir, 'link1')), 'real2');
  assert.equal(readlinkSync(join(dir, 'link2')), 'real1');
  assert.equal(readlinkSync(join(dir, 'moved')), 'nonexistent-target');
  assert.ok(lstatSync(join(dir, 'moved')).isSymbolicLink());
  assert.equal(read(dir, 'real1'), 'R1');
  assert.equal(read(dir, 'real2'), 'R2');
});

test('a new batch is refused while a journal is pending; resume finishes the original intent', () => {
  const dir = tmp();
  write(dir, 'a', 'A');
  write(dir, 'b', 'B');
  assert.equal(run(['a', 'b', 'b', 'a'], dir, { MVBATCH_FAIL_AT: '1' }).status, 75);
  const refused = run(['a', 'z'], dir);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--resume/);
  assert.equal(read(dir, 'a'), 'A', 'refused batch must not run');
  const done = run(['--resume'], dir);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(read(dir, 'a'), 'B');
  assert.equal(read(dir, 'b'), 'A');
  assert.deepEqual(names(dir), ['a', 'b']);
});

test('resume without a journal fails cleanly', () => {
  const dir = tmp();
  const r = run(['--resume'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no journal/);
});

test('plan file drives the same batch engine', () => {
  const dir = tmp();
  write(dir, 'a', 'A');
  write(dir, 'b', 'B');
  write(dir, 'plan.json', JSON.stringify([['a', 'b'], ['b', 'a']]));
  const r = run(['--plan', 'plan.json'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir, 'a'), 'B');
  assert.equal(read(dir, 'b'), 'A');
});
