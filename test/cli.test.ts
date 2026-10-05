import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): RunResult {
  // This environment's Node build loses piped stdout/stderr of spawned child
  // node processes, so go through `sh -c` with file redirection instead.
  const dir = mkdtempSync(join(tmpdir(), 'doc-merge-run-'));
  try {
    const outF = join(dir, 'out');
    const errF = join(dir, 'err');
    const codeF = join(dir, 'code');
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const cmd =
      [process.execPath, CLI, ...args].map(q).join(' ') +
      ` > ${q(outF)} 2> ${q(errF)}; echo $? > ${q(codeF)}`;
    spawnSync('sh', ['-c', cmd]);
    return {
      status: parseInt(readFileSync(codeF, 'utf8'), 10),
      stdout: readFileSync(outF, 'utf8'),
      stderr: readFileSync(errF, 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withFiles(
  files: Record<string, string>,
  fn: (dir: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), 'doc-merge-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BASE = 'alpha\nbeta\ngamma\ndelta\n';
const OURS = 'ALPHA\nbeta\ngamma\ndelta\n'; // edits line 0
const THEIRS = 'alpha\nbeta\ngamma\nDELTA\n'; // edits line 3

test('cli merge: non-overlapping edits merge cleanly, exit 0', () => {
  withFiles({ base: BASE, ours: OURS, theirs: THEIRS }, (dir) => {
    const r = run(['merge', join(dir, 'base'), join(dir, 'ours'), join(dir, 'theirs')]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'ALPHA\nbeta\ngamma\nDELTA\n');
  });
});

test('cli merge: same-line edits conflict, exit 1, markers on stdout', () => {
  withFiles(
    { base: BASE, ours: 'alpha\nB1\ngamma\ndelta\n', theirs: 'alpha\nB2\ngamma\ndelta\n' },
    (dir) => {
      const r = run(['merge', join(dir, 'base'), join(dir, 'ours'), join(dir, 'theirs')]);
      assert.equal(r.status, 1);
      assert.ok(r.stdout.includes('<<<<<<< ours'));
      assert.ok(r.stdout.includes('||||||| base'));
      assert.ok(r.stdout.includes('beta'));
      assert.ok(r.stdout.includes('>>>>>>> theirs'));
      assert.ok(r.stderr.includes('1 conflict'));
    },
  );
});

test('cli merge --json emits the reversible result', () => {
  withFiles(
    { base: BASE, ours: 'alpha\nB1\ngamma\ndelta\n', theirs: 'alpha\nB2\ngamma\ndelta\n' },
    (dir) => {
      const r = run([
        'merge', '--json',
        join(dir, 'base'), join(dir, 'ours'), join(dir, 'theirs'),
      ]);
      assert.equal(r.status, 1);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.clean, false);
      assert.equal(parsed.conflicts.length, 1);
      assert.deepEqual(parsed.conflicts[0].baseLines, ['beta']);
      assert.deepEqual(parsed.conflicts[0].oursLines, ['B1']);
      assert.deepEqual(parsed.conflicts[0].theirsLines, ['B2']);
    },
  );
});

test('cli merge --labels customizes conflict markers', () => {
  withFiles(
    { base: 'x\n', ours: 'a\n', theirs: 'b\n' },
    (dir) => {
      const r = run([
        'merge', '--labels', 'HEAD,ancestor,feature',
        join(dir, 'base'), join(dir, 'ours'), join(dir, 'theirs'),
      ]);
      assert.equal(r.status, 1);
      assert.ok(r.stdout.includes('<<<<<<< HEAD'));
      assert.ok(r.stdout.includes('||||||| ancestor'));
      assert.ok(r.stdout.includes('>>>>>>> feature'));
    },
  );
});

test('cli unmerge reconstructs the three originals (round-trip)', () => {
  withFiles(
    { base: BASE, ours: 'alpha\nB1\ngamma\ndelta\n', theirs: 'alpha\nB2\ngamma\ndelta\n' },
    (dir) => {
      const merged = join(dir, 'merged');
      const m = run(['merge', join(dir, 'base'), join(dir, 'ours'), join(dir, 'theirs')]);
      writeFileSync(merged, m.stdout);
      const u = run(['unmerge', '--json', merged]);
      assert.equal(u.status, 0);
      const docs = JSON.parse(u.stdout);
      assert.deepEqual(docs.base.join('\n') + '\n', BASE);
      assert.deepEqual(docs.ours.join('\n') + '\n', 'alpha\nB1\ngamma\ndelta\n');
      assert.deepEqual(docs.theirs.join('\n') + '\n', 'alpha\nB2\ngamma\ndelta\n');
      // default mode writes three files
      const u2 = run(['unmerge', merged]);
      assert.equal(u2.status, 0);
      assert.equal(readFileSync(`${merged}.base`, 'utf8'), BASE);
      assert.equal(readFileSync(`${merged}.ours`, 'utf8'), 'alpha\nB1\ngamma\ndelta\n');
      assert.equal(readFileSync(`${merged}.theirs`, 'utf8'), 'alpha\nB2\ngamma\ndelta\n');
    },
  );
});

test('cli: usage errors exit with code 2', () => {
  assert.equal(run([]).status, 2);
  assert.equal(run(['merge', 'only-one']).status, 2);
  assert.equal(run(['nope']).status, 2);
  assert.equal(run(['merge', '/no/such/a', '/no/such/b', '/no/such/c']).status, 2);
});
