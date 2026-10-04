import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.js';

const WORKER = fileURLToPath(new URL('../fixtures/commit-worker.mjs', import.meta.url));

// The sandbox here forbids child_process.spawn, so the CLI is exercised
// in-process through run(); bin/mv.js is a thin main() wrapper over it.
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvlin-cli-'));
  const repo = path.join(dir, 'repo');
  const cli = (args) => {
    let stdout = '';
    let stderr = '';
    const outW = process.stdout.write;
    const errW = process.stderr.write;
    process.stdout.write = (s) => ((stdout += s), true);
    process.stderr.write = (s) => ((stderr += s), true);
    let code;
    try {
      code = run(['--repo', repo, ...args]);
    } catch (e) {
      code = 1;
      stderr += `${e.code ?? 'E_INTERNAL'}: ${e.message}\n`;
    } finally {
      process.stdout.write = outW;
      process.stderr.write = errW;
    }
    return { status: code, stdout, stderr };
  };
  const write = (name, obj) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, JSON.stringify(obj));
    return f;
  };
  return { dir, repo, cli, write };
}

// Mirror of bin/mv.js main(): MvError -> "<CODE>: msg" on stderr, exit 1.
function cliMain(cli, args) {
  const r = cli(args);
  if (r.status !== 0 && !r.stderr) throw new Error('expected error output');
  return r;
}

test('CLI: commit / view / forkinfo / merge conflict / lincheck', () => {
  const { cli, write } = setup();
  const b0 = write('b0.json', { id: 'b0', pid: 'p0', clock: 1, ops: [{ op: 'assert', key: 'k', value: 0 }] });
  const r0 = cliMain(cli, ['commit', b0]);
  assert.equal(r0.status, 0, r0.stderr);
  const v0 = JSON.parse(r0.stdout).version;

  const b1 = write('b1.json', { id: 'b1', pid: 'p1', clock: 1, parent: v0, ops: [{ op: 'assert', key: 'k', value: 1 }] });
  const b2 = write('b2.json', { id: 'b2', pid: 'p2', clock: 1, parent: v0, ops: [{ op: 'assert', key: 'k', value: 2 }] });
  const r1 = cliMain(cli, ['commit', b1]);
  const r2 = cliMain(cli, ['commit', b2]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r2.status, 0, r2.stderr);
  const c2 = JSON.parse(r2.stdout);
  assert.equal(c2.conflicts.length, 1);
  assert.equal(c2.conflicts[0].key, 'k');

  const info = JSON.parse(cliMain(cli, ['forkinfo', 'main']).stdout);
  assert.equal(info.heads.length, 2);
  assert.deepEqual(info.lcas, [v0]);

  const view = JSON.parse(cliMain(cli, ['view', 'main']).stdout);
  assert.equal(view.heads.length, 2);
  assert.ok(view.headStates);

  const m = cliMain(cli, ['merge', c2.heads[0], c2.heads[1], 'main']);
  assert.equal(m.status, 1);
  assert.match(m.stderr, /E_CONFLICT/);

  const log = write('log.json', [
    { batch: 'b0', start: 0, end: 1 },
    { batch: 'b1', start: 2, end: 3 },
    { batch: 'b2', start: 2, end: 3 },
  ]);
  const lc = cliMain(cli, ['lincheck', log]);
  assert.equal(lc.status, 0, lc.stderr);
  assert.equal(JSON.parse(lc.stdout).ok, true);

  // real-time inversion: b3 depends on b1 but finishes before b1 starts
  const b3 = write('b3.json', { id: 'b3', pid: 'p3', clock: 1, deps: ['b1'], parent: c2.heads[0], ops: [{ op: 'assert', key: 'z', value: 1 }] });
  assert.equal(cliMain(cli, ['commit', b3]).status, 0);
  const inv = write('inv.json', [
    { batch: 'b1', start: 10, end: 20 },
    { batch: 'b3', start: 0, end: 5 },
  ]);
  const bad = cliMain(cli, ['lincheck', inv]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /E_NONLINEAR/);
});

test('CLI: E_ORPHAN and E_BAD_PARENT surface with their codes', () => {
  const { cli, write } = setup();
  const orphan = write('o.json', { id: 'o', pid: 'p', clock: 1, deps: ['nope'], ops: [{ op: 'assert', key: 'k', value: 1 }] });
  const r = cliMain(cli, ['commit', orphan]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /E_ORPHAN/);

  const bad = write('bad.json', { id: 'x', pid: 'p', clock: 1, parent: 'zzz', ops: [{ op: 'assert', key: 'k', value: 1 }] });
  const r2 = cliMain(cli, ['commit', bad]);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /E_BAD_PARENT/);
});

test('two analyzer workers commit concurrently to the same repo', async () => {
  const { repo, cli, write } = setup();
  const b0 = write('b0.json', { id: 'b0', pid: 'p0', clock: 1, ops: [{ op: 'assert', key: 'k', value: 0 }] });
  const v0 = JSON.parse(cliMain(cli, ['commit', b0]).stdout).version;

  // two workers (stand-ins for analyzer OS processes, which this sandbox
  // cannot spawn) race on the same repo; the lockfile serializes them
  const work = (id, pid, value) =>
    new Promise((resolve, reject) => {
      const w = new Worker(WORKER, {
        workerData: { dir: repo, batch: { id, pid, clock: 1, parent: v0, ops: [{ op: 'assert', key: 'k', value }] } },
      });
      w.on('message', resolve);
      w.on('error', reject);
    });
  const [ra, rb] = await Promise.all([work('ba', 'pa', 1), work('bb', 'pb', 2)]);
  assert.ok(ra.ok, JSON.stringify(ra));
  assert.ok(rb.ok, JSON.stringify(rb));

  const info = JSON.parse(cliMain(cli, ['forkinfo', 'main']).stdout);
  assert.equal(info.heads.length, 2); // both commits landed on a forked DAG
  assert.equal(info.versionCount, 3);
  // the second committer sees the concurrent correction as a conflict
  const conflicts = [...(ra.result.conflicts ?? []), ...(rb.result.conflicts ?? [])];
  assert.ok(conflicts.some((c) => c.key === 'k'));
});
