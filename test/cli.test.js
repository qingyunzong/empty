import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'payfuzz-'));

// Note: child stdio is redirected to files because pipe stdio is unreliable
// in some sandboxed environments; the CLI behavior under test is identical.
function run(args) {
  const dir = tmp();
  const outFd = openSync(join(dir, 'stdout'), 'w');
  const errFd = openSync(join(dir, 'stderr'), 'w');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', outFd, errFd],
    });
    child.on('error', reject);
    child.on('close', (status) => {
      closeSync(outFd);
      closeSync(errFd);
      resolve({
        status,
        stdout: readFileSync(join(dir, 'stdout'), 'utf8'),
        stderr: readFileSync(join(dir, 'stderr'), 'utf8'),
      });
    });
  });
}

test('fuzz then replay round-trips with identical hash', async () => {
  const dir = tmp();
  const out = join(dir, 'run.json');
  const f = await run(['fuzz', '--seed', '42', '--steps', '80', '--accounts', '3', '--out', out]);
  assert.equal(f.status, 0, f.stderr);
  const summary = JSON.parse(f.stdout);
  assert.match(summary.stateHash, /^[0-9a-f]{64}$/);

  const r = await run(['replay', out]);
  assert.equal(r.status, 0, r.stderr);
  const replay = JSON.parse(r.stdout);
  assert.equal(replay.ok, true);
  assert.equal(replay.stateHash, summary.stateHash);
  assert.deepEqual(replay.checks, {
    randomSamples: true,
    ops: true,
    finalState: true,
    stateHash: true,
  });
});

test('fuzz is byte-exact reproducible across processes', async () => {
  const dir = tmp();
  const a = join(dir, 'a.json');
  const b = join(dir, 'b.json');
  assert.equal((await run(['fuzz', '--seed', '42', '--steps', '80', '--accounts', '3', '--out', a])).status, 0);
  assert.equal((await run(['fuzz', '--seed', '42', '--steps', '80', '--accounts', '3', '--out', b])).status, 0);
  assert.equal(readFileSync(a, 'utf8'), readFileSync(b, 'utf8'));
});

test('invalid seed exits 1 with INVALID_INPUT', async () => {
  for (const seed of ['abc', '1.5', '-1']) {
    const r = await run(['fuzz', '--seed', seed, '--steps', '10', '--accounts', '3', '--out', join(tmp(), 'x.json')]);
    assert.equal(r.status, 1, `seed=${seed}`);
    assert.equal(JSON.parse(r.stderr).error, 'INVALID_INPUT');
  }
});

test('negative steps exits 1 with INVALID_INPUT', async () => {
  const r = await run(['fuzz', '--seed', '42', '--steps', '-5', '--accounts', '3', '--out', join(tmp(), 'x.json')]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr).error, 'INVALID_INPUT');
});

test('unknown op in replay file exits 1 with INVALID_INPUT', async () => {
  const dir = tmp();
  const out = join(dir, 'run.json');
  assert.equal((await run(['fuzz', '--seed', '42', '--steps', '5', '--accounts', '2', '--out', out])).status, 0);
  const data = JSON.parse(readFileSync(out, 'utf8'));
  data.ops[0].op = { type: 'teleport', holdId: 'H0' };
  writeFileSync(out, JSON.stringify(data));
  const r = await run(['replay', out]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr).error, 'INVALID_INPUT');
});

test('tampered run file exits 1 with REPLAY_MISMATCH', async () => {
  const dir = tmp();
  const out = join(dir, 'run.json');
  assert.equal((await run(['fuzz', '--seed', '42', '--steps', '10', '--accounts', '2', '--out', out])).status, 0);
  const data = JSON.parse(readFileSync(out, 'utf8'));
  data.randomSamples[0] = (data.randomSamples[0] + 1) >>> 0;
  writeFileSync(out, JSON.stringify(data));
  const r = await run(['replay', out]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr).error, 'REPLAY_MISMATCH');
});

test('unknown command and missing flags exit 1 with INVALID_INPUT', async () => {
  assert.equal(JSON.parse((await run(['bogus'])).stderr).error, 'INVALID_INPUT');
  assert.equal(JSON.parse((await run(['fuzz', '--seed', '1'])).stderr).error, 'INVALID_INPUT');
  assert.equal(JSON.parse((await run(['replay'])).stderr).error, 'INVALID_INPUT');
});
