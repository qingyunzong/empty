import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from './helpers.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

// The sandbox drops data on pipes attached to grandchild node processes, so
// the child's stdin/stdout/stderr are wired through temp files instead.
function run(args, { input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const io = tmpdir('obs-cli-io-');
    const inFile = path.join(io, 'stdin');
    const outFile = path.join(io, 'stdout');
    const errFile = path.join(io, 'stderr');
    fs.writeFileSync(inFile, input);
    const inFd = fs.openSync(inFile, 'r');
    const outFd = fs.openSync(outFile, 'w');
    const errFd = fs.openSync(errFile, 'w');
    const child = spawn(process.execPath, [CLI, ...args], { stdio: [inFd, outFd, errFd] });
    child.on('error', reject);
    child.on('close', (status) => {
      for (const fd of [inFd, outFd, errFd]) fs.closeSync(fd);
      resolve({
        status,
        stdout: fs.readFileSync(outFile, 'utf8'),
        stderr: fs.readFileSync(errFile, 'utf8'),
      });
    });
  });
}

async function ok(args, opts) {
  const r = await run(args, opts);
  assert.equal(r.status, 0, `expected success, stderr: ${r.stderr}`);
  assert.equal(r.stderr, '');
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function fail(args, opts) {
  const r = await run(args, opts);
  assert.notEqual(r.status, 0, `expected failure, stdout: ${r.stdout}`);
  const lines = r.stderr.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'stderr must be a single line');
  const err = JSON.parse(lines[0]);
  assert.equal(typeof err.code, 'string');
  assert.equal(typeof err.msg, 'string');
  return err;
}

test('CLI happy path: init / put / correct / delete / status', async () => {
  const dir = tmpdir();
  const [init] = await ok(['init', '--dir', dir, '--node', 'N1', '--nodes', 'N1,N2']);
  assert.equal(init.ok, true);
  assert.deepEqual(init.nodes, ['N1', 'N2']);

  const [put] = await ok(['put', '--dir', dir], { input: '{"key":"s1","value":{"temp":21.5}}\n' });
  assert.equal(put.kind, 'put');
  assert.deepEqual(put.vclock, { N1: 1 });
  assert.equal(put.lamport, 1);

  const [correct] = await ok(['correct', '--dir', dir], { input: '{"key":"s1","value":{"temp":22}}\n' });
  assert.equal(correct.lamport, 2);
  assert.deepEqual(correct.vclock, { N1: 2 });

  const [st1] = await ok(['status', '--dir', dir]);
  assert.deepEqual(st1.records.s1.value, { temp: 22 });
  assert.equal(st1.lamport, 2);

  const [del] = await ok(['delete', '--dir', dir], { input: '{"key":"s1"}\n' });
  assert.equal(del.kind, 'delete');
  const [st2] = await ok(['status', '--dir', dir]);
  assert.deepEqual(st2.records, {});
  assert.equal(st2.tombstones.length, 1);
});

test('CLI put accepts a batch of JSON lines atomically', async () => {
  const dir = tmpdir();
  await ok(['init', '--dir', dir, '--node', 'N1']);
  const out = await ok(['put', '--dir', dir], {
    input: '{"key":"a","value":1}\n{"key":"b","value":2}\n',
  });
  assert.equal(out.length, 2);
  const [st] = await ok(['status', '--dir', dir]);
  assert.deepEqual(Object.keys(st.records).sort(), ['a', 'b']);
});

test('CLI merge between stores and via stdin, idempotent on repeat', async () => {
  const dirA = tmpdir();
  const dirB = tmpdir();
  await ok(['init', '--dir', dirA, '--node', 'A']);
  await ok(['init', '--dir', dirB, '--node', 'B']);
  const [e] = await ok(['put', '--dir', dirA], { input: '{"key":"x","value":1}\n' });

  const [m1] = await ok(['merge', '--dir', dirB, '--other', dirA]);
  assert.deepEqual(m1, { ok: true, merged: 1, skipped: 0 });
  const [m2] = await ok(['merge', '--dir', dirB, '--other', dirA]);
  assert.deepEqual(m2, { ok: true, merged: 0, skipped: 1 });

  const dirC = tmpdir();
  await ok(['init', '--dir', dirC, '--node', 'C']);
  const [m3] = await ok(['merge', '--dir', dirC], { input: JSON.stringify(e) + '\n' });
  assert.equal(m3.merged, 1);
  const [m4] = await ok(['merge', '--dir', dirC], { input: JSON.stringify(e) + '\n' });
  assert.equal(m4.merged, 0);
  assert.equal(m4.skipped, 1);
});

test('CLI compare reports concurrency of two histories', async () => {
  const [r1] = await ok(['compare'], { input: '{"a":1,"b":2}\n{"a":2,"b":1}\n' });
  assert.equal(r1.relation, 'concurrent');
  const [r2] = await ok(['compare'], { input: '{"a":1}\n{"a":2}\n' });
  assert.equal(r2.relation, 'before');
  const [r3] = await ok(['compare'], { input: '{"a":2}\n{"a":2}\n' });
  assert.equal(r3.relation, 'equal');
});

test('CLI errors: single-line {code,msg} on stderr, non-zero exit', async () => {
  const dir = tmpdir();
  await ok(['init', '--dir', dir, '--node', 'N1']);

  const e1 = await fail(['correct', '--dir', dir], { input: '{"key":"nope","value":1}\n' });
  assert.equal(e1.code, 'KEY_NOT_FOUND');

  await ok(['put', '--dir', dir], { input: '{"key":"k","value":1}\n' });
  const e2 = await fail(['put', '--dir', dir], { input: '{"key":"k","value":2}\n' });
  assert.equal(e2.code, 'KEY_EXISTS');

  const e3 = await fail(['put', '--dir', dir], { input: 'not json\n' });
  assert.equal(e3.code, 'INVALID_INPUT');

  const e4 = await fail(['delete', '--dir', dir], { input: '{"value":1}\n' });
  assert.equal(e4.code, 'INVALID_INPUT');

  const e5 = await fail(['bogus', '--dir', dir]);
  assert.equal(e5.code, 'USAGE');

  const e6 = await fail(['status', '--dir', path.join(dir, 'missing')]);
  assert.equal(e6.code, 'STORE_NOT_FOUND');

  const e7 = await fail(['init', '--dir', dir, '--node', 'N1']);
  assert.equal(e7.code, 'STORE_EXISTS');
});

test('CLI compact: refuses before all nodes have seen the tombstone', async () => {
  const dirA = tmpdir();
  const dirB = tmpdir();
  await ok(['init', '--dir', dirA, '--node', 'A', '--nodes', 'A,B']);
  await ok(['init', '--dir', dirB, '--node', 'B', '--nodes', 'A,B']);
  await ok(['put', '--dir', dirA], { input: '{"key":"k","value":1}\n' });
  await ok(['delete', '--dir', dirA], { input: '{"key":"k"}\n' });

  const [c1] = await ok(['compact', '--dir', dirA, '--retention-ms', '0']);
  assert.equal(c1.removed, 0, 'B has not seen the tombstone yet');

  await ok(['merge', '--dir', dirB, '--other', dirA]);
  await ok(['merge', '--dir', dirA, '--other', dirB]);
  const [c2] = await ok(['compact', '--dir', dirA, '--retention-ms', '0']);
  assert.ok(c2.removed >= 2);
  const [st] = await ok(['status', '--dir', dirA]);
  assert.equal(st.tombstones.length, 0);
});
