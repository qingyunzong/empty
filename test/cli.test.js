import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../src/cli.js';
import { tmpdir } from './helpers.js';

// The sandbox forbids spawning child processes, so the CLI entry function is
// exercised in-process with captured streams; bin/cli.js is a thin wrapper.
function run(dir, cmd, arg) {
  const io = {
    out: '', err: '',
    stdout(s) { this.out += s; },
    stderr(s) { this.err += s; },
  };
  const argv = [dir, cmd];
  if (arg !== undefined) argv.push(JSON.stringify(arg));
  const code = runCli(argv, io);
  return { code, out: io.out ? JSON.parse(io.out) : JSON.parse(io.err) };
}

test('CLI happy path emits JSON with certificate', () => {
  const dir = tmpdir();
  let r = run(dir, 'create', { id: 'P', weight: 100 });
  assert.equal(r.code, 0);
  assert.equal(r.out.ok, true);
  assert.match(r.out.certificate.hash, /^[0-9a-f]{64}$/);

  r = run(dir, 'split', { parent: 'P', children: [{ id: 'A', weight: 30 }, { id: 'B', weight: 40 }] });
  assert.equal(r.code, 0);

  r = run(dir, 'lineage', { id: 'A' });
  assert.deepEqual(r.out.ancestors, ['P']);
  assert.deepEqual(r.out.descendants, []);

  r = run(dir, 'merge', { parents: ['A', 'B'], child: { id: 'M', weight: 50 } });
  assert.equal(r.code, 0);
  r = run(dir, 'lineage', { id: 'M' });
  assert.deepEqual(r.out.ancestors, ['A', 'B', 'P']);

  r = run(dir, 'qc', { id: 'M', status: 'passed' });
  assert.equal(r.code, 0);

  r = run(dir, 'verify');
  assert.equal(r.out.valid, true);

  r = run(dir, 'certificate');
  assert.equal(r.out.certificate.seq, 4);
});

test('CLI business errors exit 1', () => {
  const dir = tmpdir();
  run(dir, 'create', { id: 'P', weight: 10 });
  let r = run(dir, 'split', { parent: 'P', children: [{ id: 'A', weight: 11 }] });
  assert.equal(r.code, 1);
  assert.equal(r.out.error.type, 'business');

  assert.equal(run(dir, 'create', { id: 'P', weight: 1 }).code, 1); // duplicate
  assert.equal(run(dir, 'nonsense', {}).code, 1);                   // unknown command
  assert.equal(run(dir, 'lineage', { id: 'ghost' }).code, 1);       // missing batch
});

test('CLI corruption errors exit 2', () => {
  const dir = tmpdir();
  run(dir, 'create', { id: 'P', weight: 10 });
  fs.writeFileSync(path.join(dir, 'state.json'), '{"payload":{"batches":{}},"sum":"deadbeef"}');
  const r = run(dir, 'state');
  assert.equal(r.code, 2);
  assert.equal(r.out.error.type, 'corruption');
});
