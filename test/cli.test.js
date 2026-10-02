import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runAudit, AuditError } from '../src/audit.js';

const BIN = new URL('../bin/demand.js', import.meta.url).pathname;
const T0 = Date.parse('2026-01-05T00:00:00Z');
const iso = (min) => new Date(T0 + min * 60000).toISOString();

function makeDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'demand-'));
  mkdirSync(path.join(dir, 'in'));
  return dir;
}

// The sandbox swallows stdio of grandchild node processes, so capture via files.
function runCli(args, dir) {
  const quoted = [BIN, ...args].map((a) => `'${String(a).replaceAll("'", "'\\''")}'`).join(' ');
  const script = `node ${quoted} >'${dir}/stdout.txt' 2>'${dir}/stderr.txt'; echo $? >'${dir}/status.txt'`;
  spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return {
    status: Number(readFileSync(path.join(dir, 'status.txt'), 'utf8').trim()),
    stdout: readFileSync(path.join(dir, 'stdout.txt'), 'utf8'),
    stderr: readFileSync(path.join(dir, 'stderr.txt'), 'utf8'),
  };
}

const meter = (id, min, kwh, estimated = false) =>
  JSON.stringify({ type: 'meter', id, eventTs: iso(min), meter: 'M1', kwh, estimated });

test('acceptance 4a: kwh rollback without retraction aborts with METER_ROLLBACK (lib)', () => {
  assert.throws(() => runAudit([meter('r0', 0, 100), meter('r1', 15, 90)]), (e) => {
    assert.ok(e instanceof AuditError);
    assert.equal(e.code, 'METER_ROLLBACK');
    return true;
  });
});

test('acceptance 4b: negative first kwh reading is a rollback against the zero baseline', () => {
  assert.throws(() => runAudit([meter('r0', 0, -5)]), (e) => e.code === 'METER_ROLLBACK');
});

test('acceptance 4c: rollback corrected by retraction is accepted', () => {
  const r = runAudit([
    meter('r0', 0, 100),
    meter('r1', 15, 90),
    JSON.stringify({ type: 'retract', eventTs: iso(16), kind: 'meter', id: 'r1' }),
    meter('r2', 15, 110),
  ]);
  assert.equal(r.windows[0].kwh, 10);
});

test('acceptance 4d: CLI exits 1 and reports METER_ROLLBACK on stderr', () => {
  const dir = makeDir();
  writeFileSync(path.join(dir, 'in', 'events.jsonl'), [meter('r0', 0, 100), meter('r1', 15, 90)].join('\n') + '\n');
  const res = runCli(['audit', '--in', path.join(dir, 'in'), '--out', path.join(dir, 'out')], dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /METER_ROLLBACK/);
  assert.ok(!existsSync(path.join(dir, 'out', 'settlement.json')));
});

test('CLI audit writes windows.jsonl, settlement.json, comp.jsonl, late.log', () => {
  const dir = makeDir();
  const lines = [
    meter('r0', 0, 100),
    JSON.stringify({ type: 'tariff', id: 't1', eventTs: iso(0), name: 'peak', start: iso(0), end: iso(15), rate: 12.5 }),
    JSON.stringify({ type: 'shed', id: 's1', eventTs: iso(5), load: 'HVAC-1', kw: 50 }),
    meter('r1', 15, 160, true),
    meter('r2', 15, 130),
    JSON.stringify({ type: 'retract', eventTs: iso(20), kind: 'meter', id: 'r1' }),
    JSON.stringify({ type: 'retract', eventTs: iso(25), kind: 'shed', id: 's1' }),
  ];
  writeFileSync(path.join(dir, 'in', 'events.jsonl'), lines.join('\n') + '\n');
  const res = runCli(['audit', '--in', path.join(dir, 'in'), '--out', path.join(dir, 'out'), '--budget', '80'], dir);
  assert.equal(res.status, 0, res.stderr);

  const windows = readFileSync(path.join(dir, 'out', 'windows.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].kwh, 30);
  assert.equal(windows[0].demandKw, 120);
  assert.equal(windows[0].shedKw, 50);
  assert.equal(windows[0].baselineKw, 170);
  assert.equal(windows[0].rate, 12.5);
  assert.equal(windows[0].tariff, 'peak');
  assert.equal(windows[0].estimated, false);
  assert.equal(windows[0].final, true);

  const settlement = JSON.parse(readFileSync(path.join(dir, 'out', 'settlement.json'), 'utf8'));
  assert.equal(settlement.windowCount, 1);
  assert.equal(settlement.budgetKw, 80);
  assert.equal(settlement.watermark, iso(24));
  assert.equal(settlement.peak.demandKw, 120);
  assert.equal(settlement.optimal.cost, 1500); // (170-50)*12.5
  assert.equal(settlement.executed.cost, 1500);
  assert.equal(settlement.executedIsOptimal, true);

  const comp = readFileSync(path.join(dir, 'out', 'comp.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(comp.length, 1);
  assert.equal(comp[0].reason, 'SHED_RETRACT_FORBIDDEN');

  assert.equal(readFileSync(path.join(dir, 'out', 'late.log'), 'utf8'), '');
});

test('CLI rejects bad usage with exit code 2', () => {
  const dir = makeDir();
  const res = runCli(['audit'], dir);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage/);
});
