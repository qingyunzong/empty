import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { BIN, runCli, lines, mulberry32 } from '../testutil/helpers.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clearing-'));
}

const EVENTS = [
  { type: 'add_institution', id: 'A' },
  { type: 'add_institution', id: 'B' },
  { type: 'submit', id: 'i1', version: 1, from: 'A', to: 'B', amount: 100 },
  { type: 'commit' },
  { type: 'submit', id: 'i2', version: 1, from: 'B', to: 'A', amount: 30 },
  { type: 'commit' },
  { type: 'revoke', id: 'i1' },
  { type: 'submit', id: 'i3', version: 1, from: 'A', to: 'B', amount: 12 },
  { type: 'commit' },
];

function batchFiles(dir) {
  return fs.readdirSync(dir).filter((f) => /^batch-\d+\.json$/.test(f)).sort();
}

test('torn journal tail and stale tmp batch are healed on restart', () => {
  const dir = tmpdir();
  const first = runCli(lines(EVENTS.slice(0, 4)), { state: dir });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(batchFiles(dir), ['batch-1.json']);

  // Simulate a kill in the middle of writes: torn journal tail + half-written tmp batch.
  fs.appendFileSync(path.join(dir, 'journal.jsonl'), '{"event":{"type":"subm');
  fs.writeFileSync(path.join(dir, 'batch-2.json.tmp'), '{"n":2,"nets":{"A":');

  const second = runCli(lines(EVENTS.slice(4)), { state: dir });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /truncated torn journal tail/);

  // No half batch: every batch file parses and no tmp files remain.
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
  const batches = batchFiles(dir);
  assert.deepEqual(batches, ['batch-1.json', 'batch-2.json', 'batch-3.json']);
  for (const name of batches) {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    assert.match(parsed.hash, /^[0-9a-f]{64}$/);
  }

  // Final state equals a clean reference run.
  const reference = runCli(lines(EVENTS));
  const finalOut = second.stdout.trim().split('\n').map(JSON.parse).at(-1);
  const refOut = reference.stdout.trim().split('\n').map(JSON.parse).at(-1);
  assert.deepEqual(finalOut.nets, refOut.nets);
  assert.equal(finalOut.certificate, refOut.certificate);
});

function runUntilKilled(dir, events, seed) {
  return new Promise((resolve, reject) => {
    const inPath = path.join(dir, 'in.jsonl');
    fs.writeFileSync(inPath, lines(events));
    const inFd = fs.openSync(inPath, 'r');
    const outFd = fs.openSync(path.join(dir, 'out.jsonl'), 'w');
    const errFd = fs.openSync(path.join(dir, 'err.txt'), 'w');
    const child = spawn(process.execPath, [BIN, '--state', dir], {
      stdio: [inFd, outFd, errFd],
    });
    child.on('error', reject);
    child.on('close', () => {
      fs.closeSync(inFd);
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      resolve();
    });
    // Kill at an arbitrary moment while the journal is being written.
    const rand = mulberry32(seed);
    setTimeout(() => child.kill('SIGKILL'), Math.floor(rand() * 30));
  });
}

test('SIGKILL mid-run never leaves a half batch; restart converges to reference', async (t) => {
  // A longer stream with many commits so the kill lands mid-processing.
  const stream = [];
  for (const id of ['A', 'B', 'C']) stream.push({ type: 'add_institution', id });
  for (let k = 0; k < 60; k += 1) {
    const from = ['A', 'B', 'C'][k % 3];
    const to = ['A', 'B', 'C'][(k + 1) % 3];
    stream.push({ type: 'submit', id: `i${k}`, version: 1, from, to, amount: 10 + k });
    if (k % 3 === 2) stream.push({ type: 'commit' });
    if (k % 7 === 3) stream.push({ type: 'revoke', id: `i${k - 1}` });
  }
  const reference = runCli(lines(stream));
  assert.equal(reference.status, 0, reference.stderr);
  const refFinal = reference.stdout.trim().split('\n').map(JSON.parse).at(-1);
  const refBatches = reference.stdout.trim().split('\n').map(JSON.parse).at(-1).batch;

  for (let iter = 0; iter < 8; iter += 1) {
    const dir = tmpdir();
    await runUntilKilled(dir, stream, iter + 1);

    // Count how many events were durably journaled before the kill.
    const journalPath = path.join(dir, 'journal.jsonl');
    let journaled = 0;
    if (fs.existsSync(journalPath)) {
      for (const line of fs.readFileSync(journalPath, 'utf8').split('\n')) {
        if (line === '') continue;
        try {
          JSON.parse(line);
          journaled += 1;
        } catch {
          break; // torn tail
        }
      }
    }

    const resumed = runCli(lines(stream.slice(journaled)), { state: dir });
    assert.equal(resumed.status, 0, resumed.stderr);

    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
    for (const name of batchFiles(dir)) {
      JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); // must be complete JSON
    }
    assert.equal(batchFiles(dir).length, refBatches);

    const finalOut = resumed.stdout.trim().split('\n').map(JSON.parse).at(-1);
    assert.deepEqual(finalOut.nets, refFinal.nets);
    assert.equal(finalOut.certificate, refFinal.certificate);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
