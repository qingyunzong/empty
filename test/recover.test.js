import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLog, makeDir, writeJsonl, runCli } from './helpers.js';

// Simulates the patch write protocol (new.tmp -> cert.tmp -> rename -> rename)
// crashed at each fault point, and asserts recover/check classify the state.

function setup() {
  const dir = makeDir();
  const old = join(dir, 'old.jsonl');
  const fix = join(dir, 'fix.json');
  const out = join(dir, 'new.jsonl');
  const cert = join(dir, 'cert.json');
  writeJsonl(old, makeLog(4));
  writeFileSync(fix, JSON.stringify({ patchOps: [{ op: 'void', seq: 2, reason: 'r' }] }));
  return { dir, old, fix, out, cert };
}

test('state old: crash before any rename leaves originals authoritative', () => {
  const { old, fix, out, cert } = setup();
  // crash after writing tmp files, before renames
  writeFileSync(out + '.tmp', 'partial-new');
  writeFileSync(cert + '.tmp', 'partial-cert');

  const rec = runCli(['recover', out, cert]);
  assert.equal(rec.code, 0);
  assert.match(rec.stdout, /STATE old/);
  assert.match(rec.stdout, /rm .*new\.jsonl\.tmp/);

  const chk = runCli(['check', old, out, cert]);
  assert.equal(chk.code, 12);
  assert.match(chk.stderr, /STATE old/);

  // rollback instruction is actionable: remove tmps, old log still verifies
  rmSync(out + '.tmp');
  rmSync(cert + '.tmp');
  assert.equal(runCli(['verify', old]).code, 0);
});

test('state old: patch never ran', () => {
  const { old, out, cert } = setup();
  const rec = runCli(['recover', out, cert]);
  assert.equal(rec.code, 0);
  assert.match(rec.stdout, /STATE old/);
  assert.equal(runCli(['check', old, out, cert]).code, 12);
});

test('state partial: crash between renames refuses to mix, gives rollback', () => {
  const { old, fix, out, cert } = setup();
  // full patch in a scratch dir to obtain real artifacts
  const scratch = makeDir();
  const sOut = join(scratch, 'new.jsonl');
  const sCert = join(scratch, 'cert.json');
  assert.equal(runCli(['patch', old, fix, '--out', sOut, '--cert', sCert]).code, 0);
  // simulate crash after first rename: new.jsonl renamed, cert.json.tmp left behind
  renameSync(sOut, out);
  renameSync(sCert, cert + '.tmp');

  const rec = runCli(['recover', out, cert]);
  assert.equal(rec.code, 12);
  assert.match(rec.stderr, /STATE partial/);
  assert.match(rec.stderr, /do NOT mix/i);
  assert.match(rec.stderr, /rm .*new\.jsonl/);

  const chk = runCli(['check', old, out, cert]);
  assert.equal(chk.code, 12);
  assert.match(chk.stderr, /STATE partial/);

  // rollback: remove stray outputs, re-run patch cleanly
  rmSync(out);
  rmSync(cert + '.tmp');
  assert.equal(runCli(['patch', old, fix, '--out', out, '--cert', cert]).code, 0);
  assert.equal(runCli(['check', old, out, cert]).code, 0);
});

test('state new: both renames done, check passes; stale tmps only noted', () => {
  const { old, fix, out, cert } = setup();
  assert.equal(runCli(['patch', old, fix, '--out', out, '--cert', cert]).code, 0);
  writeFileSync(out + '.tmp', 'stale'); // leftover from a killed earlier run

  const rec = runCli(['recover', out, cert]);
  assert.equal(rec.code, 0);
  assert.match(rec.stdout, /STATE new/);
  assert.match(rec.stdout, /stale tmp/);

  assert.equal(runCli(['check', old, out, cert]).code, 0);
  assert.ok(existsSync(out) && existsSync(cert));
});
