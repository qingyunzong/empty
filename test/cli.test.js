import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));

function setupInput(tasks, events) {
  const dir = mkdtempSync(join(tmpdir(), 'asrs-sim-'));
  const inDir = join(dir, 'in');
  const outDir = join(dir, 'out');
  mkdirSync(inDir);
  writeFileSync(join(inDir, 'tasks.json'), JSON.stringify(tasks));
  writeFileSync(join(inDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { inDir, outDir };
}

function runCli(inDir, outDir) {
  return spawnSync(process.execPath, [cliPath, 'sim', '--in', inDir, '--out', outDir], {
    encoding: 'utf8',
  });
}

test('CLI: clean run exits 0 and writes final_slots.json + ledger.jsonl, no errors.jsonl', () => {
  const { inDir, outDir } = setupInput(
    { tasks: [{ task_id: 'T1', type: 'inbound', target: 'S1', priority: 1, aisle: 'A1' }] },
    [
      { type: 'assign', task_id: 'T1' },
      { type: 'start', task_id: 'T1' },
      { type: 'finish', task_id: 'T1' },
    ],
  );
  const proc = runCli(inDir, outDir);
  assert.equal(proc.status, 0, proc.stderr);

  const finalSlots = JSON.parse(readFileSync(join(outDir, 'final_slots.json'), 'utf8'));
  assert.equal(finalSlots.tasks.T1, 'done');
  assert.equal(finalSlots.slots.S1.occupied, true);

  const ledger = readFileSync(join(outDir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(ledger.map((e) => e.event), ['assign', 'start', 'finish']);

  assert.equal(existsSync(join(outDir, 'errors.jsonl')), false);
});

test('CLI: cancel of done task -> errors.jsonl with INVALID_STATE, exit 2, run continues', () => {
  const { inDir, outDir } = setupInput(
    {
      tasks: [
        { task_id: 'T1', type: 'inbound', target: 'S1', priority: 1, aisle: 'A1' },
        { task_id: 'T2', type: 'inbound', target: 'S2', priority: 1, aisle: 'A1' },
      ],
    },
    [
      { type: 'assign', task_id: 'T1' },
      { type: 'start', task_id: 'T1' },
      { type: 'finish', task_id: 'T1' },
      { type: 'cancel', task_id: 'T1' }, // INVALID_STATE, must not abort
      { type: 'assign', task_id: 'T2' },
    ],
  );
  const proc = runCli(inDir, outDir);
  assert.equal(proc.status, 2, proc.stderr);

  const errors = readFileSync(join(outDir, 'errors.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'INVALID_STATE');
  assert.equal(errors[0].task_id, 'T1');

  // later events were still processed
  const finalSlots = JSON.parse(readFileSync(join(outDir, 'final_slots.json'), 'utf8'));
  assert.equal(finalSlots.tasks.T2, 'assigned');
});

test('CLI: blocked-aisle convergence is recorded in ledger with deterministic exit_order', () => {
  const events = [
    { type: 'assign', task_id: 'LO' },
    { type: 'assign', task_id: 'HI' },
    { type: 'start', task_id: 'LO' },
    { type: 'start', task_id: 'HI' },
    { type: 'block_aisle', aisle: 'A1' },
    { type: 'finish', task_id: 'LO' },
    { type: 'finish', task_id: 'HI' },
    { type: 'unblock_aisle', aisle: 'A1' },
  ];
  const tasks = {
    tasks: [
      { task_id: 'LO', type: 'inbound', target: 'S1', priority: 1, aisle: 'A1' },
      { task_id: 'HI', type: 'inbound', target: 'S2', priority: 5, aisle: 'A1' },
    ],
  };
  const first = setupInput(tasks, events);
  const second = setupInput(tasks, events);
  assert.equal(runCli(first.inDir, first.outDir).status, 0);
  assert.equal(runCli(second.inDir, second.outDir).status, 0);

  const ledgerA = readFileSync(join(first.outDir, 'ledger.jsonl'), 'utf8');
  const ledgerB = readFileSync(join(second.outDir, 'ledger.jsonl'), 'utf8');
  assert.equal(ledgerA, ledgerB); // reproducible across runs

  const unblock = ledgerA.trim().split('\n').map(JSON.parse).find((e) => e.event === 'unblock_aisle');
  assert.deepEqual(unblock.exit_order, ['HI', 'LO']);
});

test('CLI: malformed events.jsonl line -> PARSE_ERROR, exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asrs-sim-'));
  const inDir = join(dir, 'in');
  const outDir = join(dir, 'out');
  mkdirSync(inDir);
  writeFileSync(join(inDir, 'tasks.json'), JSON.stringify({ tasks: [] }));
  writeFileSync(join(inDir, 'events.jsonl'), '{"type":"block_aisle","aisle":"A1"}\nnot-json\n');
  const proc = runCli(inDir, outDir);
  assert.equal(proc.status, 2);
  const errors = readFileSync(join(outDir, 'errors.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'PARSE_ERROR');
});

test('CLI: usage error exits 1', () => {
  const proc = spawnSync(process.execPath, [cliPath], { encoding: 'utf8' });
  assert.equal(proc.status, 1);
});
