import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

let dir;

function writeJsonl(name, events) {
  const path = join(dir, name);
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

// Drives the CLI in-process (the sandbox forbids spawning grandchildren) and
// captures exit code plus stdout/stderr exactly as the bin wrapper would emit.
function run(args) {
  let stdout = '';
  let stderr = '';
  const status = runCli(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { status, stdout, stderr };
}

const LOG_A = [
  { id: 'a:1', member: 'a', epoch: 1, seq: 1, kind: 'join', clock: { a: 1 } },
  { id: 'a:2', member: 'a', epoch: 1, seq: 2, kind: 'interlock', valve: 'V1', clock: { a: 2 } },
];
const LOG_B = [
  { id: 'b:1', member: 'b', epoch: 1, seq: 1, kind: 'join', clock: { b: 1 } },
  { id: 'b:2', member: 'b', epoch: 1, seq: 2, kind: 'bypass', valve: 'V1', clock: { a: 1, b: 2 } },
];
const LOG_C = [
  { id: 'c:1', member: 'c', epoch: 1, seq: 1, kind: 'join', clock: { c: 1 } },
  { id: 'c:2', member: 'c', epoch: 1, seq: 2, kind: 'reset', valve: 'V1', clock: { a: 2, b: 2, c: 2 } },
];
const LOG_UNKNOWN = [
  { id: 'g:1', member: 'ghost', epoch: 1, seq: 1, kind: 'interlock', valve: 'V9', clock: { ghost: 1 } },
];

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'boiler-cli-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('merge of three collector logs prints final state and certificate', () => {
  const [fa, fb, fc] = [writeJsonl('a.jsonl', LOG_A), writeJsonl('b.jsonl', LOG_B), writeJsonl('c.jsonl', LOG_C)];
  const res = run(['merge', fa, fb, fc]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.valves.V1.status, 'NORMAL'); // c:2 reset causally follows interlock+bypass
  assert.equal(out.valves.V1.lastEvent, 'c:2');
  assert.equal(out.certificate.events, 6);
  assert.equal(out.certificate.accepted, 6);
  assert.equal(out.certificate.rejected, 0);
  assert.match(out.certificate.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(out.certificate.clock, { a: 2, b: 2, c: 2 });
  assert.equal(out.certificate.inputs.length, 3);
});

test('status prints per-valve status and member epochs', () => {
  const fa = writeJsonl('a.jsonl', LOG_A);
  const res = run(['status', fa]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.valves.V1.status, 'INTERLOCKED');
  assert.deepEqual(out.members.a, { currentEpoch: 1, active: true, leftEpochs: [] });
});

test('merge is order-independent across file argument order', () => {
  const [fa, fb, fc] = [writeJsonl('a.jsonl', LOG_A), writeJsonl('b.jsonl', LOG_B), writeJsonl('c.jsonl', LOG_C)];
  const r1 = JSON.parse(run(['merge', fa, fb, fc]).stdout);
  const r2 = JSON.parse(run(['merge', fc, fa, fb]).stdout);
  assert.equal(r1.certificate.digest, r2.certificate.digest);
  assert.deepEqual(r1.valves, r2.valves);
});

test('unknown member event exits 4', () => {
  const fg = writeJsonl('ghost.jsonl', LOG_UNKNOWN);
  const res = run(['merge', fg]);
  assert.equal(res.status, 4);
  const err = JSON.parse(res.stderr);
  assert.equal(err.error.code, 'E_UNKNOWN_MEMBER');
  assert.equal(err.error.member, 'ghost');
});

test('digest of one file prints hash, clock and ids', () => {
  const fa = writeJsonl('a.jsonl', LOG_A);
  const res = run(['digest', fa]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.match(out.hash, /^sha256:/);
  assert.deepEqual(out.clock, { a: 2 });
  assert.deepEqual(out.ids, ['a:1', 'a:2']);
});

test('digest compare of identical logs exits 0', () => {
  const fa = writeJsonl('a.jsonl', LOG_A);
  const fa2 = writeJsonl('a-copy.jsonl', [...LOG_A].reverse());
  const res = run(['digest', fa, fa2]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).equal, true);
});

test('digest mismatch exits 5 and prints the divergence range', () => {
  const fa = writeJsonl('a.jsonl', LOG_A);
  const fb = writeJsonl('b.jsonl', LOG_B);
  const res = run(['digest', fa, fb]);
  assert.equal(res.status, 5);
  const out = JSON.parse(res.stdout);
  assert.equal(out.equal, false);
  const byMember = Object.fromEntries(out.divergence.map((d) => [d.member, d]));
  assert.deepEqual(byMember.a.onlyInA, [{ from: 1, to: 2 }]);
  assert.deepEqual(byMember.b.onlyInB, [{ from: 1, to: 2 }]);
});

test('invalid JSONL input exits 2', () => {
  const path = join(dir, 'broken.jsonl');
  writeFileSync(path, '{"id":"x"\n');
  const res = run(['merge', path]);
  assert.equal(res.status, 2);
});

test('usage error exits 2', () => {
  const res = run(['merge']);
  assert.equal(res.status, 2);
});
