import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from '../src/cli.js';
import { threeShiftConfig } from './helpers.js';

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'gate-cli-'));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name, content) {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

// Invokes the CLI in-process (the offline sandbox forbids child processes)
// and captures stdout/stderr plus the returned exit code.
function run(args) {
  const io = { stdout: [], stderr: [] };
  const status = runCli(args, {
    out: (s) => io.stdout.push(s),
    err: (s) => io.stderr.push(s),
  });
  return { status, stdout: io.stdout.join('\n'), stderr: io.stderr.join('\n') };
}

const goodEvents = [
  { ts: '2026-10-04T20:00:00Z', type: 'release', order: 'WO-1' },
  { ts: '2026-10-04T20:05:00Z', type: 'release', order: 'WO-2', priority: 1 },
  { ts: '2026-10-04T20:10:00Z', type: 'freeze', order: 'WO-1' },
  { ts: '2026-10-04T20:15:00Z', type: 'revoke', target: 3, actor: 'supervisor' },
  { ts: '2026-10-04T20:20:00Z', type: 'reschedule', order: 'WO-2', to: '2026-10-04T22:30:00Z' },
];

test('CLI run writes schedule.out.json, breach.json, compensation.jsonl', () => {
  const config = write('plant.json', JSON.stringify(threeShiftConfig()));
  const events = write('release.jsonl', goodEvents.map((e) => JSON.stringify(e)).join('\n'));
  const res = run(['run', '--config', config, '--events', events, '--date', '2026-10-04', '--outdir', dir]);
  assert.equal(res.status, 0, res.stderr);
  const schedule = JSON.parse(readFileSync(join(dir, 'schedule.out.json'), 'utf8'));
  const breach = JSON.parse(readFileSync(join(dir, 'breach.json'), 'utf8'));
  assert.ok(existsSync(join(dir, 'compensation.jsonl')));
  assert.equal(schedule.date, '2026-10-04');
  assert.equal(schedule.shifts.length, 3);
  assert.equal(schedule.shifts[2].end, '2026-10-05T06:00:00.000Z');
  const nightOrders = schedule.shifts[2].orders;
  assert.equal(nightOrders.length, 1);
  assert.equal(nightOrders[0].order, 'WO-2');
  assert.equal(nightOrders[0].crossesMidnight, true);
  assert.equal(breach.stateHash, schedule.stateHash);
  // freeze seq 3 was revoked, so WO-1 is released again and scheduled too.
  const dayOrders = schedule.shifts[0].orders;
  assert.ok(dayOrders.some((o) => o.order === 'WO-1'));
  // freeze seq 3 overrode a lock-holding release: one compensation was emitted.
  const comp = readFileSync(join(dir, 'compensation.jsonl'), 'utf8').trim();
  assert.equal(comp.split('\n').length, 1);
  assert.equal(JSON.parse(comp).order, 'WO-1');
});

test('CLI replay from an event number matches full-run hash', () => {
  const config = write('plant.json', JSON.stringify(threeShiftConfig()));
  const events = write('release.jsonl', goodEvents.map((e) => JSON.stringify(e)).join('\n'));
  const full = run(['replay', '--config', config, '--events', events]);
  assert.equal(full.status, 0, full.stderr);
  const fullHash = JSON.parse(full.stdout).stateHash;
  for (const from of [1, 3, 4]) {
    const res = run(['replay', '--config', config, '--events', events, '--from', String(from)]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).stateHash, fullHash, `replay from ${from} diverges`);
  }
});

test('CLI exits 5 on time backwards', () => {
  const config = write('plant.json', JSON.stringify(threeShiftConfig()));
  const events = write(
    'backwards.jsonl',
    [
      JSON.stringify({ ts: '2026-10-04T21:00:00Z', type: 'release', order: 'WO-1' }),
      JSON.stringify({ ts: '2026-10-04T20:00:00Z', type: 'freeze', order: 'WO-1' }),
    ].join('\n'),
  );
  const res = run(['validate', '--config', config, '--events', events]);
  assert.equal(res.status, 5, res.stderr);
});

test('CLI exits 6 on negative capability', () => {
  const bad = threeShiftConfig();
  bad.productLines['PL-1'].workCenters['WC-1'].capabilities.assembly = -3;
  const config = write('negcap.json', JSON.stringify(bad));
  const events = write('empty.jsonl', '');
  const res = run(['validate', '--config', config, '--events', events]);
  assert.equal(res.status, 6, res.stderr);
});

test('CLI exits 7 on unknown material', () => {
  const bad = threeShiftConfig();
  bad.productLines['PL-1'].workCenters['WC-1'].orders['WO-1'].materials = { 'M-GHOST': 1 };
  const config = write('unknownmat.json', JSON.stringify(bad));
  const events = write('empty.jsonl', '');
  const res = run(['validate', '--config', config, '--events', events]);
  assert.equal(res.status, 7, res.stderr);
});

test('CLI counterexample prints a minimal freeze sequence', () => {
  const config = write('plant.json', JSON.stringify(threeShiftConfig()));
  const events = write(
    'ce.jsonl',
    JSON.stringify({ ts: '2026-10-04T20:00:00Z', type: 'release', order: 'WO-1' }),
  );
  const res = run(['counterexample', '--config', config, '--events', events, '--order', 'WO-1']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.sequence.length, 1);
  assert.equal(out.sequence[0].type, 'freeze');
});
