import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qcl-cli-'));
}
function run(dir, args, env = {}) {
  const outFile = path.join(dir, '.out.log');
  const errFile = path.join(dir, '.err.log');
  const r = spawnSync(process.execPath, [CLI, `--dir=${dir}`, ...args], {
    env: { ...process.env, ...env, QCL_OUT: outFile, QCL_ERR: errFile },
    encoding: 'utf8',
  });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  const out = read(outFile).trim();
  const err = read(errFile).trim();
  fs.rmSync(outFile, { force: true });
  fs.rmSync(errFile, { force: true });
  return { code: r.status, out, err };
}
const json = (r) => JSON.parse(r.out);

test('full loop: open -> rework -> close fail -> rework -> close pass -> verify', () => {
  const dir = tmpdir();
  assert.equal(json(run(dir, ['open', 'd1', '--desc=crack'])).node, 'n1');
  assert.equal(json(run(dir, ['rework', 'r1', 'd1'])).node, 'n2');
  assert.equal(json(run(dir, ['close', 'r1', '--result=fail'])).node, 'n3');
  assert.equal(json(run(dir, ['state'])).defects.d1.status, 'open'); // back to open
  assert.equal(json(run(dir, ['rework', 'r2', 'd1'])).node, 'n4');
  const closed = json(run(dir, ['close', 'r2', '--result=pass']));
  const v = json(run(dir, ['verify']));
  assert.equal(v.hash, closed.hash); // recovery hash == live hash
  assert.equal(v.seq, 5);
  assert.deepEqual(v.index.defectsByStatus, { closed: 1 });
  // snapshot was written atomically by close
  assert.ok(fs.existsSync(path.join(dir, 'snapshot.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'snapshot.json.tmp')));
});

test('usage errors exit non-zero with message', () => {
  const dir = tmpdir();
  assert.equal(run(dir, ['close', 'nope', '--result=pass']).code, 1);
  assert.match(run(dir, ['close', 'nope', '--result=pass']).err, /does not exist/);
  run(dir, ['open', 'd1']);
  const dup = run(dir, ['open', 'd1']);
  assert.equal(dup.code, 1);
  assert.match(dup.err, /already exists/);
  const badResult = run(dir, ['rework', 'r1', 'd1']);
  assert.equal(badResult.code, 0);
  const bad = run(dir, ['close', 'r1', '--result=maybe']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /pass\|fail\|scrap/);
});
