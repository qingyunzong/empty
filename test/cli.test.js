import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repoRoot, 'src', 'cli.js');

function makeIo() {
  const io = {
    stdoutText: '',
    stderrText: '',
    stdout(text) {
      this.stdoutText += text;
    },
    stderr(text) {
      this.stderrText += text;
    },
  };
  return io;
}

function writeJson(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function spawnCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}

const baseInput = {
  batches: [
    { batchId: 'A1', materialId: 'A', qty: 2, expiresAt: '2026-01-01' },
    { batchId: 'C1', materialId: 'C', qty: 2, expiresAt: '2026-01-02' },
  ],
  substitutions: [{ material: 'A', substitute: 'C' }],
  orders: [{ orderId: 'O1', dueDate: '2026-03-01', lines: [{ materialId: 'A', qty: 3 }] }],
};

test('cli kit produces a report and supports undo/redo commands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-cli-'));
  const inputPath = writeJson(dir, 'input.json', baseInput);
  const commandsPath = writeJson(dir, 'commands.json', [
    { op: 'holdBatch', batchId: 'A1' },
    { op: 'undo' },
    { op: 'redo' },
  ]);
  const outPath = join(dir, 'out.json');
  const io = makeIo();
  const code = run(['kit', inputPath, commandsPath, '-o', outPath], io);
  assert.equal(code, 0);
  assert.equal(io.stderrText, '');
  assert.match(io.stdoutText, /applied 3 command/);

  const report = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(report.orders[0].status, 'SHORT');
  assert.deepEqual(report.orders[0].lines[0].reservations, [{ batchId: 'C1', qty: 2 }]);
  assert.deepEqual(report.orders[0].shortages, [
    {
      lineId: 'L1',
      materialId: 'A',
      required: 3,
      reservedQty: 2,
      missing: 1,
      substitutesTried: ['C'],
    },
  ]);
  const held = report.batches.find((batch) => batch.batchId === 'A1');
  assert.equal(held.status, 'HOLD');
  assert.equal(held.reservedQty, 0);
});

test('cli rejects substitution cycles with exit code 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-cli-'));
  const inputPath = writeJson(dir, 'input.json', {
    substitutions: [
      { material: 'A', substitute: 'B' },
      { material: 'B', substitute: 'C' },
    ],
  });
  const commandsPath = writeJson(dir, 'commands.json', [
    { op: 'addSubstitution', material: 'C', substitute: 'A' },
  ]);
  const outPath = join(dir, 'out.json');
  const io = makeIo();
  const code = run(['kit', inputPath, commandsPath, '-o', outPath], io);
  assert.equal(code, 1);
  assert.match(io.stderrText, /CYCLE/);
  assert.equal(existsSync(outPath), false);
});

test('cli rejects over-consumption with exit code 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-cli-'));
  const inputPath = writeJson(dir, 'input.json', {
    batches: [{ batchId: 'B1', materialId: 'A', qty: 1, expiresAt: '2026-01-01' }],
  });
  const commandsPath = writeJson(dir, 'commands.json', [
    { op: 'consumeBatch', batchId: 'B1', qty: 5 },
  ]);
  const io = makeIo();
  const code = run(['kit', inputPath, commandsPath, '-o', join(dir, 'out.json')], io);
  assert.equal(code, 1);
  assert.match(io.stderrText, /OVER_CONSUME/);
});

test('cli rejects unknown batches with exit code 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-cli-'));
  const inputPath = writeJson(dir, 'input.json', { batches: [] });
  const commandsPath = writeJson(dir, 'commands.json', [{ op: 'holdBatch', batchId: 'GHOST' }]);
  const io = makeIo();
  const code = run(['kit', inputPath, commandsPath, '-o', join(dir, 'out.json')], io);
  assert.equal(code, 1);
  assert.match(io.stderrText, /UNKNOWN_BATCH/);
});

test('cli reports usage errors with exit code 2', () => {
  const io = makeIo();
  const code = run(['kit', 'only-one.json'], io);
  assert.equal(code, 2);
  assert.match(io.stderrText, /usage:/);
});

test('cli prints the report to stdout when -o is omitted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-cli-'));
  const inputPath = writeJson(dir, 'input.json', baseInput);
  const commandsPath = writeJson(dir, 'commands.json', []);
  const io = makeIo();
  const code = run(['kit', inputPath, commandsPath], io);
  assert.equal(code, 0);
  const report = JSON.parse(io.stdoutText);
  assert.equal(report.orders[0].status, 'OK');
});

test('cli executable exits 0 and writes the report file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-cli-'));
  const inputPath = writeJson(dir, 'input.json', baseInput);
  const commandsPath = writeJson(dir, 'commands.json', [{ op: 'holdBatch', batchId: 'A1' }]);
  const outPath = join(dir, 'out.json');
  const code = await spawnCli(['kit', inputPath, commandsPath, '-o', outPath]);
  assert.equal(code, 0);
  const report = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(report.orders[0].status, 'SHORT');
});

test('cli executable exits 1 on command errors and 2 on usage errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-cli-'));
  const inputPath = writeJson(dir, 'input.json', { batches: [] });
  const commandsPath = writeJson(dir, 'commands.json', [{ op: 'holdBatch', batchId: 'GHOST' }]);
  assert.equal(await spawnCli(['kit', inputPath, commandsPath, '-o', join(dir, 'out.json')]), 1);
  assert.equal(await spawnCli(['kit']), 2);
});
