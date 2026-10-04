import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ClearingEngine } from '../src/engine.js';
import { Store } from '../src/store.js';

const BIN = new URL('../bin/clearing.js', import.meta.url).pathname;

const EVENTS = [
  { type: 'submit', id: 'a', version: 1, payer: 'X', payee: 'Y', amountCents: 100 },
  { type: 'submit', id: 'b', version: 1, payer: 'Y', payee: 'Z', amountCents: 40 },
  { type: 'revoke', id: 'a' },
];
const INPUT = EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n';

// The sandbox drops pipe I/O between node processes, so the CLI child is
// driven through real files instead of spawnSync pipes.
function runCliProcess(args, { input, env } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clearing-stdio-'));
  const stdinPath = path.join(tmp, 'stdin.jsonl');
  const stdoutPath = path.join(tmp, 'stdout.txt');
  const stderrPath = path.join(tmp, 'stderr.txt');
  fs.writeFileSync(stdinPath, input ?? '');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: [
        fs.openSync(stdinPath, 'r'),
        fs.openSync(stdoutPath, 'w'),
        fs.openSync(stderrPath, 'w'),
      ],
      env: env ?? process.env,
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        code,
        signal,
        stdout: fs.readFileSync(stdoutPath, 'utf8'),
        stderr: fs.readFileSync(stderrPath, 'utf8'),
      });
    });
  });
}

test('kill mid batch-write: restart shows no half batch and correct nets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearing-crash-'));
  const crashed = await runCliProcess(['--state-dir', dir], {
    input: INPUT,
    env: { ...process.env, CLEARING_TEST_CRASH_DURING_BATCH_WRITE: '1' },
  });
  assert.equal(crashed.signal, 'SIGKILL', `expected SIGKILL, got ${crashed.signal}/${crashed.code}`);

  for (const file of fs.readdirSync(dir)) {
    if (/^batch-\d+\.json$/.test(file)) {
      JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    }
  }

  const restarted = await runCliProcess(['--state-dir', dir], { input: INPUT });
  assert.equal(restarted.code, 0, restarted.stderr);
  const lines = restarted.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[2].nets, { X: 0, Y: -40, Z: 40 });

  const fresh = ClearingEngine.recomputeAll(EVENTS);
  assert.equal(lines[2].certificate, fresh.certificate);

  const batches = fs
    .readdirSync(dir)
    .filter((f) => /^batch-\d+\.json$/.test(f))
    .sort();
  assert.ok(batches.length > 0);
  const latest = JSON.parse(fs.readFileSync(path.join(dir, batches.at(-1)), 'utf8'));
  assert.equal(latest.certificate, fresh.certificate);
  assert.equal(latest.batchSeq, fresh.batchSeq);
});

test('recovery continues sequence numbers from the journal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearing-recover-'));
  const first = await runCliProcess(['--state-dir', dir], {
    input: JSON.stringify(EVENTS[0]) + '\n',
  });
  assert.equal(first.code, 0, first.stderr);
  const second = await runCliProcess(['--state-dir', dir], {
    input: JSON.stringify(EVENTS[1]) + '\n',
  });
  assert.equal(second.code, 0, second.stderr);
  const line = JSON.parse(second.stdout.trim());
  assert.equal(line.seq, 2);
  assert.deepEqual(line.nets, { X: -100, Y: 60, Z: 40 });
});

test('truncated final journal line is tolerated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearing-journal-'));
  const store = new Store(dir);
  store.appendEvent({ seq: 1, event: EVENTS[0] });
  store.appendEvent({ seq: 2, event: EVENTS[1] });
  fs.appendFileSync(store.journalPath, '{"seq":3,"event":{"type":"sub');
  const { events } = store.recover();
  assert.equal(events.length, 2);
});
