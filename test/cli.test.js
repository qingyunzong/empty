import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT, main } from '../src/cli.js';

let dir;
test.before(() => { dir = mkdtempSync(join(tmpdir(), 'furnace-')); });
test.after(() => { rmSync(dir, { recursive: true, force: true }); });

// In-process driver: exercises the full CLI code path without process spawns.
function cli(argv, state) {
  let out = '';
  let err = '';
  const code = main([...argv, '--state', state], {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

const initArgs = (over = {}) => {
  const c = {
    days: '1', runs: '1', slots: '2', gas: '10', diff: '2',
    crucibles: 'alumina:4', usage: 'n2:2,h2:5,o2:3', hazards: 'h2:o2',
    ...over,
  };
  return [
    'init', '--days', c.days, '--max-runs-per-day', c.runs, '--slots', c.slots,
    '--gas-budget', c.gas, '--max-temp-diff', c.diff,
    '--crucibles', c.crucibles, '--gas-usage', c.usage, '--hazards', c.hazards,
  ];
};

const addRecipe = (id, priority, over = {}) => [
  'add_recipe', '--id', id, '--priority', String(priority),
  '--temps', over.temps ?? '1,2', '--atmos', over.atmos ?? 'n2',
  '--durs', over.durs ?? '1', '--crucible', over.crucible ?? 'alumina',
];

test('end-to-end: init, add, optimize -> exit 0 with optimal schedule', () => {
  const s = join(dir, 'basic.json');
  assert.equal(cli(initArgs(), s).code, EXIT.OK);
  assert.equal(cli(addRecipe('R1', 5), s).code, EXIT.OK);
  assert.equal(cli(addRecipe('R2', 3), s).code, EXIT.OK);
  const res = cli(['optimize'], s);
  assert.equal(res.code, EXIT.OK);
  const out = JSON.parse(res.out);
  assert.equal(out.status, 'OPTIMAL');
  assert.equal(out.objective, 8);
});

test('UNSAT -> exit 2 with minimal hazardous core', () => {
  const s = join(dir, 'unsat.json');
  cli([...initArgs(), '--required-priority', '10'], s);
  cli(addRecipe('R1', 10, { atmos: 'h2' }), s);
  cli(addRecipe('R2', 10, { atmos: 'o2' }), s);
  cli(addRecipe('R3', 10), s);
  const res = cli(['optimize'], s);
  assert.equal(res.code, EXIT.UNSAT);
  assert.deepEqual(JSON.parse(res.out).core, ['R1', 'R2']);
});

test('budget exhaustion -> exit 3 with PENDING and bounds', () => {
  const s = join(dir, 'pending.json');
  cli([...initArgs(), '--required-priority', '10'], s);
  cli(addRecipe('R1', 10), s);
  cli(addRecipe('R2', 10), s);
  const res = cli(['optimize', '--budget-backtrack', '0'], s);
  assert.equal(res.code, EXIT.PENDING);
  const out = JSON.parse(res.out);
  assert.equal(out.status, 'PENDING');
  assert.ok(out.bound.lower <= out.bound.upper);
});

test('lock on a scheduled variable -> exit 4', () => {
  const s = join(dir, 'lock-scheduled.json');
  cli(initArgs(), s);
  cli(addRecipe('R1', 5), s);
  cli(['optimize'], s);
  const res = cli(['lock_slot', '--recipe', 'R1', '--batch', '0', '--temp', '1', '--atmo', 'n2', '--dur', '1'], s);
  assert.equal(res.code, EXIT.USAGE);
  assert.match(res.err, /scheduled/);
});

test('restore on an empty snapshot stack -> exit 4', () => {
  const s = join(dir, 'restore-empty.json');
  cli(initArgs(), s);
  const res = cli(['restore'], s);
  assert.equal(res.code, EXIT.USAGE);
  assert.match(res.err, /snapshot stack empty/);
});

test('unknown command and malformed values -> exit 4', () => {
  const s = join(dir, 'usage.json');
  assert.equal(cli(['frobnicate'], s).code, EXIT.USAGE);
  assert.equal(cli(initArgs({ slots: 'x' }), s).code, EXIT.USAGE);
  assert.equal(cli(['add_recipe', '--id', 'R1'], s).code, EXIT.USAGE);
});

test('snapshot/restore round-trip across invocations', () => {
  const s = join(dir, 'snap.json');
  cli(initArgs(), s);
  cli(addRecipe('R1', 5), s);
  assert.equal(cli(['snapshot'], s).code, EXIT.OK);
  cli(addRecipe('R2', 4), s);
  assert.equal(cli(['snapshot'], s).code, EXIT.OK);
  cli(addRecipe('R3', 3), s);
  assert.equal(cli(['restore'], s).code, EXIT.OK);
  assert.equal(cli(['restore'], s).code, EXIT.OK);
  assert.equal(cli(['restore'], s).code, EXIT.USAGE); // stack exhausted
  const out = JSON.parse(cli(['optimize'], s).out);
  assert.equal(out.status, 'OPTIMAL');
  assert.equal(out.objective, 5); // only R1 survived the restores
});

test('lock then unlock recomputes equivalently to the unlocked instance', () => {
  const locked = join(dir, 'locked.json');
  const fresh = join(dir, 'fresh.json');
  for (const s of [locked, fresh]) {
    cli(initArgs(), s);
    cli(addRecipe('R1', 5), s);
    cli(addRecipe('R2', 5), s);
  }
  cli(['lock_slot', '--recipe', 'R1', '--batch', '0', '--temp', '1', '--atmo', 'n2', '--dur', '1'], locked);
  cli(['optimize'], locked);
  cli(['unlock_slot', '--recipe', 'R1'], locked);
  const afterUnlock = JSON.parse(cli(['optimize'], locked).out);
  const freshOut = JSON.parse(cli(['optimize'], fresh).out);
  assert.deepEqual(afterUnlock, freshOut);
});

// Note: process-level exit codes (0/2/3/4) are produced by bin/furnace.js as
// `process.exitCode = main(argv)`. Nested node spawns are not possible in
// every sandbox, so the tests above assert main()'s return codes directly;
// the mapping is additionally verified from the shell in RESULTS.md.
test('exit code constants match the documented contract', () => {
  assert.deepEqual(EXIT, { OK: 0, UNSAT: 2, PENDING: 3, USAGE: 4 });
});
