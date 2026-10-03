import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frame } from '../testutil/sign.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'cli.js');

// The sandbox swallows grandchild stdio pipes, so capture via files.
function runCli(lines, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'dvp-'));
  const file = join(dir, 'in.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');
  const outPath = join(dir, 'out.txt');
  const errPath = join(dir, 'err.txt');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, ...extraArgs, file], { stdio: ['ignore', outFd, errFd] });
    p.on('error', reject);
    p.on('close', (status) => {
      closeSync(outFd);
      closeSync(errFd);
      resolve({ status, stdout: readFileSync(outPath, 'utf8'), stderr: readFileSync(errPath, 'utf8') });
    });
  });
}

const base = () => [
  frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 100, price: 100, seq: 1, ts: 1 }),
  frame({ op: 'new', clOrdId: 'S1', side: 'sell', qty: 60, price: 100, seq: 2, ts: 2 }),
  frame({ op: 'match', clOrdId: 'M1', seq: 3, ts: 3 }),
];

test('happy path: exit 0, JSONL events, audit root last', async () => {
  const r = await runCli(base().map((f) => JSON.stringify(f)));
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines.at(-1).type, 'audit');
  assert.match(lines.at(-1).root, /^[0-9a-f]{64}$/);
  assert.ok(lines.some((l) => l.type === 'trade' && l.qty === 60));
  assert.ok(lines.some((l) => l.type === 'freeze'));
  assert.ok(lines.some((l) => l.type === 'remaining'));
  assert.ok(lines.some((l) => l.type === 'end'));
});

test('retransmission + reordering do not change the audit root (重传/去重/乱序)', async () => {
  const frames = base();
  const canonicalRun = await runCli(frames.map((f) => JSON.stringify(f)));
  // reverse arrival order and retransmit every frame twice
  const messy = [...frames, ...frames].reverse().map((f) => JSON.stringify(f));
  const messyRun = await runCli(messy);
  assert.equal(canonicalRun.status, 0);
  assert.equal(messyRun.status, 0, messyRun.stderr);
  const root1 = JSON.parse(canonicalRun.stdout.trim().split('\n').at(-1)).root;
  const root2 = JSON.parse(messyRun.stdout.trim().split('\n').at(-1)).root;
  assert.equal(root1, root2);
});

test('exit 2 on frame error (bad crc)', async () => {
  const bad = { ...base()[0], crc: 'deadbeef' };
  const r = await runCli([JSON.stringify(bad)]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /crc mismatch/);
});

test('exit 2 on malformed JSON', async () => {
  const r = await runCli(['{"op":"new"']);
  assert.equal(r.status, 2);
});

test('exit 3 on unknown origId', async () => {
  const r = await runCli([JSON.stringify(frame({ op: 'cancel', clOrdId: 'C1', origId: 'NOPE', seq: 1 }))]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /unknown origId: NOPE/);
});

test('exit 4 on duplicate clOrdId with different payload', async () => {
  const a = frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 100, price: 100, seq: 1 });
  const b = frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 200, price: 100, seq: 2 });
  const r = await runCli([JSON.stringify(a), JSON.stringify(b)]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /duplicate clOrdId/);
});
