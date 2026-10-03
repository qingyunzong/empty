import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { runMain } from '../src/app.js';
import { baseConfig, writeConfig, writeEvents, tmpDir } from './helpers.js';

function runCli(args) {
  const out = [];
  const err = [];
  const status = runMain(args, { stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

const T0 = '2026-10-04T20:00:00Z';
const iso = (min) => new Date(Date.parse(T0) + min * 60_000).toISOString();

test('exit 5 on time regression', () => {
  const dir = tmpDir();
  writeConfig(dir, baseConfig());
  const events = writeEvents(dir, [
    { ts: iso(20), type: 'release', orderId: 'W1', actor: 'planner' },
    { ts: iso(10), type: 'freeze', orderId: 'W1', actor: 'planner' },
  ]);
  const r = runCli(['run', '--config', dir, '--events', events, '--out', path.join(dir, 'o.json'), '--breach', path.join(dir, 'b.json')]);
  assert.equal(r.status, 5);
  assert.match(r.stderr, /time regression/);
});

test('exit 6 on negative capability', () => {
  const dir = tmpDir();
  const cfg = baseConfig();
  cfg.capabilities.WC1.S3 = -10;
  writeConfig(dir, cfg);
  const events = writeEvents(dir, []);
  const r = runCli(['run', '--config', dir, '--events', events]);
  assert.equal(r.status, 6);
  assert.match(r.stderr, /negative capability/);
});

test('exit 7 on unknown material', () => {
  const dir = tmpDir();
  const cfg = baseConfig();
  cfg.orders[0].materials = { M_UNKNOWN: 1 };
  writeConfig(dir, cfg);
  const events = writeEvents(dir, []);
  const r = runCli(['run', '--config', dir, '--events', events]);
  assert.equal(r.status, 7);
  assert.match(r.stderr, /unknown material/);
});

test('run writes schedule.out.json, breach.json and audit.jsonl; replay from arbitrary event matches', () => {
  const dir = tmpDir();
  writeConfig(dir, baseConfig());
  const events = writeEvents(dir, [
    { ts: iso(10), type: 'release', orderId: 'W1', actor: 'planner', priority: 1 },
    { ts: iso(20), type: 'release', orderId: 'W2', actor: 'planner', priority: 1 },
    { ts: iso(30), type: 'freeze', orderId: 'W1', actor: 'planner', priority: 1 },
    { ts: iso(40), type: 'revoke', orderId: 'W1', actor: 'supervisor', priority: 2 },
    { ts: iso(50), type: 'reschedule', orderId: 'W2', actor: 'planner', toShift: 'S2' },
  ]);
  const out = path.join(dir, 'schedule.out.json');
  const breach = path.join(dir, 'breach.json');
  const audit = path.join(dir, 'audit.jsonl');
  const r = runCli(['run', '--config', dir, '--events', events, '--out', out, '--breach', breach, '--audit', audit]);
  assert.equal(r.status, 0, r.stderr);
  const sched = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(sched.queue.length, 2);
  assert.equal(sched.queue.find((q) => q.orderId === 'W2').shift, 'S2');
  const br = JSON.parse(readFileSync(breach, 'utf8'));
  assert.equal(br.compensations.length, 1);
  assert.equal(br.compensations[0].orderId, 'W1');
  assert.ok(existsSync(audit));

  for (const from of [1, 3, 5]) {
    const rp = runCli(['replay', '--config', dir, '--events', events, '--audit', audit, '--from', String(from)]);
    assert.equal(rp.status, 0, `replay from ${from}: ${rp.stderr}`);
    const parsed = JSON.parse(rp.stdout);
    assert.equal(parsed.prefixMatch, true);
    assert.equal(parsed.finalMatch, true);
  }
});

test('counterexample CLI emits minimal freeze sequence', () => {
  const dir = tmpDir();
  writeConfig(dir, baseConfig());
  const events = writeEvents(dir, [
    { ts: iso(10), type: 'release', orderId: 'W1', actor: 'planner', priority: 1 },
  ]);
  const r = runCli(['counterexample', '--config', dir, '--events', events, '--order', 'W1']);
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.found, true);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'freeze');
});
