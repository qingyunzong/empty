import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../src/cli.js';
import { tmpdir } from './helpers.js';

// The CLI is driven in-process via runCli(): same parsing, same exit codes,
// same stdout/stderr JSON contracts as the bin/evpack.js entry point.

function cli(args, { expectOk = true } = {}) {
  const res = runCli(args);
  if (expectOk) {
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}: ${res.stderr}`);
    assert.equal(res.stderr, '');
    return JSON.parse(res.stdout);
  }
  assert.notEqual(res.code, 0, 'expected non-zero exit');
  const err = JSON.parse(res.stderr);
  assert.ok(err.error && typeof err.error.code === 'string', 'stderr must be JSON with error.code');
  return { status: res.code, err };
}

function fixture() {
  const dir = path.join(tmpdir(), 'pack');
  cli(['init', dir, '--members', 'alice,bob']);
  cli(['add', dir, '--data', '{"n":1}', '--member', 'alice']);
  cli(['add', dir, '--data', '{"n":2}', '--member', 'bob']);
  cli(['add', dir, '--data', '{"n":3}', '--member', 'alice']);
  return dir;
}

test('CLI happy path: init/add/prove/verify/digest emit JSON', () => {
  const dir = fixture();
  const digest = cli(['digest', dir]);
  assert.equal(digest.count, 3);
  assert.equal(digest.heads.length, 1);

  const proof = cli(['prove', dir, '--index', '1']);
  assert.equal(proof.digest, digest.digest);
  const proofFile = path.join(tmpdir(), 'proof.json');
  fs.writeFileSync(proofFile, JSON.stringify(proof));
  const verified = cli(['verify', dir, '--proof', proofFile]);
  assert.equal(verified.ok, true);

  const full = cli(['verify', dir]);
  assert.equal(full.ok, true);
  assert.equal(full.digest, digest.digest);
});

test('CLI: tampered block exits 2 with TAMPER_DETECTED stderr JSON', () => {
  const dir = fixture();
  const file = path.join(dir, 'blocks', '000001.json');
  const bytes = Buffer.from(fs.readFileSync(file, 'utf8'));
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  fs.writeFileSync(file, bytes);
  const { status, err } = cli(['verify', dir], { expectOk: false });
  assert.equal(status, 2);
  assert.equal(err.error.code, 'TAMPER_DETECTED');
});

test('CLI: missing block exits 3 with MISSING_BLOCK stderr JSON', () => {
  const dir = fixture();
  fs.rmSync(path.join(dir, 'blocks', '000002.json'));
  const { status, err } = cli(['verify', dir], { expectOk: false });
  assert.equal(status, 3);
  assert.equal(err.error.code, 'MISSING_BLOCK');
  assert.equal(err.error.details.index, 2);
});

test('CLI: invalid proof exits 4 with INVALID_PROOF stderr JSON', () => {
  const dir = fixture();
  const proof = cli(['prove', dir, '--index', '0']);
  const h = proof.proof[0].hash;
  proof.proof[0].hash = (h[0] === 'f' ? 'e' : 'f') + h.slice(1); // corrupt one sibling
  const proofFile = path.join(tmpdir(), 'bad-proof.json');
  fs.writeFileSync(proofFile, JSON.stringify(proof));
  const { status, err } = cli(['verify', dir, '--proof', proofFile], { expectOk: false });
  assert.equal(status, 4);
  assert.equal(err.error.code, 'INVALID_PROOF');
});

test('CLI: proof for a different digest exits 4', () => {
  const dir = fixture();
  const proof = cli(['prove', dir, '--index', '0']);
  const proofFile = path.join(tmpdir(), 'proof.json');
  fs.writeFileSync(proofFile, JSON.stringify(proof));
  const { status, err } = cli(['verify', dir, '--proof', proofFile, '--digest', '0'.repeat(64)], { expectOk: false });
  assert.equal(status, 4);
  assert.equal(err.error.code, 'INVALID_PROOF');
});

test('CLI: stale-epoch write exits 5 with STALE_EPOCH stderr JSON', () => {
  const dir = fixture();
  cli(['members', dir, '--set', 'alice,carol', '--member', 'alice']);
  const { status, err } = cli(['add', dir, '--data', '{"n":4}', '--member', 'alice', '--epoch', '0'], { expectOk: false });
  assert.equal(status, 5);
  assert.equal(err.error.code, 'STALE_EPOCH');
  assert.equal(err.error.details.currentEpoch, 1);
});

test('CLI: removed member write exits 6 with NOT_MEMBER stderr JSON', () => {
  const dir = fixture();
  cli(['members', dir, '--set', 'alice', '--member', 'alice']);
  const { status, err } = cli(['add', dir, '--data', '{"n":4}', '--member', 'bob'], { expectOk: false });
  assert.equal(status, 6);
  assert.equal(err.error.code, 'NOT_MEMBER');
});

test('CLI: sync converges two replicas and is idempotent', () => {
  const a = path.join(tmpdir(), 'a');
  cli(['init', a, '--members', 'alice']);
  const jsonl = path.join(tmpdir(), 'in.jsonl');
  fs.writeFileSync(jsonl, '{"k":1}\n{"k":2}\n{"k":3}\n{"k":4}\n');
  cli(['add', a, '--jsonl', jsonl, '--member', 'alice']);

  // replica b = prefix snapshot of a (first 2 blocks), rebuilt honestly
  const b = path.join(tmpdir(), 'b');
  cli(['init', b, '--members', 'alice']);
  fs.writeFileSync(jsonl, '{"k":1}\n{"k":2}\n');
  cli(['add', b, '--jsonl', jsonl, '--member', 'alice']);
  assert.equal(cli(['digest', b]).count, 2);

  const first = cli(['sync', b, a]);
  assert.equal(first.a.pulled, 2); // b (first dir) pulls the missing interval from a
  assert.equal(first.b.pulled, 0);
  const second = cli(['sync', b, a]);
  assert.equal(second.a.pulled, 0);
  assert.equal(second.b.pulled, 0);
  assert.equal(cli(['digest', b]).digest, cli(['digest', a]).digest);
  assert.equal(cli(['verify', b]).ok, true);
});
