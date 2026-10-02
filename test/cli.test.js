import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'limit.js');
const dir = mkdtempSync(join(tmpdir(), 'limit-cli-'));

function run(args, lines) {
  const tag = Math.random().toString(36).slice(2);
  const file = join(dir, `ops-${tag}.jsonl`);
  const outFile = join(dir, `out-${tag}.txt`);
  const errFile = join(dir, `err-${tag}.txt`);
  writeFileSync(file, lines.join('\n') + '\n');
  const cmd = [process.execPath, bin, ...args, file]
    .map((a) => `'${a}'`)
    .join(' ');
  const res = spawnSync(
    '/bin/sh',
    ['-c', `${cmd} > '${outFile}' 2> '${errFile}'`],
    { encoding: 'utf8' }
  );
  return {
    status: res.status,
    stdout: readFileSync(outFile, 'utf8'),
    stderr: readFileSync(errFile, 'utf8'),
  };
}

test('CLI run: all-ok ops exit 0 and print final state', () => {
  const res = run(['run'], [
    JSON.stringify({ op: 'open', acc: 'alice', creditLimit: 100 }),
    JSON.stringify({ op: 'freeze', authId: 'a1', acc: 'alice', amount: 60, ttl: 100, t: 0 }),
    JSON.stringify({ op: 'capture', authId: 'a1', amount: 25, t: 1 }),
    JSON.stringify({ op: 'release', authId: 'a1', t: 2 }),
  ]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
  assert.equal(out.ok, true);
  assert.deepEqual(out.accounts.alice, { creditLimit: 100, frozen: 0, used: 25 });
});

test('CLI run --explain: failing op prints E_* per line and exits non-zero', () => {
  const res = run(['run', '--explain'], [
    JSON.stringify({ op: 'open', acc: 'alice', creditLimit: 50 }),
    JSON.stringify({ op: 'freeze', authId: 'a1', acc: 'alice', amount: 40, ttl: 10, t: 0 }),
    JSON.stringify({ op: 'freeze', authId: 'a2', acc: 'alice', amount: 20, ttl: 10, t: 0 }),
    JSON.stringify({ op: 'capture', authId: 'a1', amount: 5, t: 10 }),
  ]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /#1 .* -> ok/);
  assert.match(res.stdout, /#2 .* -> E_LIMIT/);
  assert.match(res.stdout, /#3 .* -> E_EXPIRED/);
});

test('CLI check: linearizable log exits 0 with witness, impossible log exits 1', () => {
  const good = run(['check'], [
    JSON.stringify({ op: 'open', acc: 'alice', creditLimit: 100, t: 0, result: 'ok' }),
    JSON.stringify({ op: 'freeze', authId: 'a1', acc: 'alice', amount: 50, ttl: 10, t: 0, result: 'ok' }),
    JSON.stringify({ op: 'capture', authId: 'a1', amount: 30, t: 5, result: 'ok' }),
    JSON.stringify({ op: 'release', authId: 'a1', t: 20, result: 'E_EXPIRED' }),
  ]);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /LINEARIZABLE witness=/);

  const bad = run(['check'], [
    JSON.stringify({ op: 'open', acc: 'alice', creditLimit: 100, t: 0, result: 'ok' }),
    JSON.stringify({ op: 'freeze', authId: 'a1', acc: 'alice', amount: 100, ttl: 10, t: 0, result: 'ok' }),
    JSON.stringify({ op: 'capture', authId: 'a1', amount: 100, t: 5, result: 'ok' }),
    JSON.stringify({ op: 'capture', authId: 'a1', amount: 100, t: 6, result: 'ok' }),
  ]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /NOT_LINEARIZABLE/);
});
