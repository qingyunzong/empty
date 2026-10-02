import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, readFileSync, openSync, closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function makeState() {
  return join(mkdtempSync(join(tmpdir(), 'netting-')), 'state.json');
}

function cli(state, ...args) {
  const dir = mkdtempSync(join(tmpdir(), 'netting-io-'));
  const outPath = join(dir, 'out.txt');
  const errPath = join(dir, 'err.txt');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [CLI, '--state', state, ...args], {
      stdio: ['ignore', outFd, errFd],
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const stdout = readFileSync(outPath, 'utf8').trim();
  return {
    status: result.status,
    stdout: stdout ? JSON.parse(stdout) : null,
    stderr: readFileSync(errPath, 'utf8'),
  };
}

test('CLI: instruct, net, settle happy path', () => {
  const state = makeState();
  for (const [id, payer, payee, amount] of [
    ['i1', 'A', 'B', '100'],
    ['i2', 'B', 'C', '40'],
    ['i3', 'C', 'A', '25'],
  ]) {
    const res = cli(state, 'instruct', '--id', id, '--payer', payer, '--payee', payee, '--amount', amount);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.ok, true);
    assert.equal(res.stdout.id, id);
    assert.match(res.stdout.hash, /^[0-9a-f]{64}$/);
  }

  const net = cli(state, 'net');
  assert.equal(net.status, 0);
  assert.deepEqual(net.stdout, { net: { A: 75, B: -60, C: -15 } });

  const settle = cli(state, 'settle', '--budget', 'A=100', '--budget', 'B=100', '--budget', 'C=100');
  assert.equal(settle.status, 0);
  assert.equal(settle.stdout.status, 'settled');
  assert.deepEqual(
    settle.stdout.instructions.map((i) => i.id),
    ['i1', 'i2', 'i3'],
  );
  assert.deepEqual(settle.stdout.net, { A: 75, B: -60, C: -15 });
});

test('CLI: budget-exceeded blocks settle until instruction is cancelled', () => {
  const state = makeState();
  cli(state, 'instruct', '{"id":"i1","payer":"A","payee":"B","amount":100}');
  cli(state, 'instruct', '{"id":"i2","payer":"B","payee":"C","amount":40}');
  cli(state, 'instruct', '{"id":"i3","payer":"C","payee":"A","amount":25}');

  const blocked = cli(state, 'settle', '{"budgets":{"A":50}}');
  assert.equal(blocked.status, 1);
  assert.deepEqual(blocked.stdout, { error: 'budget-exceeded' });

  const cancel = cli(state, 'cancel', '{"id":"i1"}');
  assert.equal(cancel.status, 0);
  assert.equal(cancel.stdout.ok, true);

  const settled = cli(state, 'settle', '{"budgets":{"A":50}}');
  assert.equal(settled.status, 0);
  assert.equal(settled.stdout.status, 'settled');
  assert.deepEqual(settled.stdout.net, { A: -25, B: 40, C: -15 });
});

test('CLI: repeated cancel is idempotent, unknown cancel is rejected', () => {
  const state = makeState();
  cli(state, 'instruct', '{"id":"i1","payer":"A","payee":"B","amount":10}');

  assert.equal(cli(state, 'cancel', '--id', 'i1').status, 0);
  const again = cli(state, 'cancel', '--id', 'i1');
  assert.equal(again.status, 0);
  assert.equal(again.stdout.ok, true);

  const unknown = cli(state, 'cancel', '--id', 'ghost');
  assert.equal(unknown.status, 1);
  assert.deepEqual(unknown.stdout, { error: 'unknown-instruction' });
});

test('CLI: merge applies events from a file', () => {
  const source = makeState();
  cli(source, 'instruct', '{"id":"i1","payer":"A","payee":"B","amount":100}');
  cli(source, 'instruct', '{"id":"i2","payer":"B","payee":"C","amount":40}');
  cli(source, 'cancel', '{"id":"i1"}');

  const state = JSON.parse(readFileSync(source, 'utf8'));
  const events = [
    ...state.instructions.map((i) => ({ type: 'instruct', ...i })),
    ...state.cancels,
  ];
  const mergeFile = join(mkdtempSync(join(tmpdir(), 'netting-merge-')), 'events.json');
  writeFileSync(mergeFile, JSON.stringify(events));

  const target = makeState();
  const merged = cli(target, 'merge', mergeFile);
  assert.equal(merged.status, 0);
  assert.deepEqual(merged.stdout, { ok: true, applied: 3 });

  const net = cli(target, 'net');
  assert.deepEqual(net.stdout, { net: { B: 40, C: -40 } });

  const dup = cli(target, 'merge', mergeFile);
  assert.equal(dup.status, 0, 're-merging the same events is idempotent');
});

test('CLI: unknown command and invalid JSON produce error codes', () => {
  const state = makeState();
  const unknown = cli(state, 'frobnicate');
  assert.equal(unknown.status, 1);
  assert.deepEqual(unknown.stdout, { error: 'unknown-command' });

  const bad = cli(state, 'instruct', '{"id":');
  assert.equal(bad.status, 1);
  assert.deepEqual(bad.stdout, { error: 'invalid-json' });
});
