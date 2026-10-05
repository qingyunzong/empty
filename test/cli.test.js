import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runCli, tmpFile } from '../testing/helpers.mjs';
import { EXIT } from '../src/errors.js';

const config = { tools: { T1: 100 }, segments: { 'O1/OP1/S1': 200 } };

const measure = (id, length, deps = []) => ({
  id, type: 'measure', tool: 'T1', order: 'O1', op: 'OP1', seg: 'S1', length, deps,
});
const cut = (id, length, deps = []) => ({
  id, type: 'cut', tool: 'T1', order: 'O1', op: 'OP1', seg: 'S1', length, deps,
});

function fixture(events, cfg = config) {
  const log = tmpFile('log.jsonl', events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const configPath = tmpFile('config.json', JSON.stringify(cfg));
  return { log, configPath };
}

test('replay of a clean log exits 0 and prints final state', () => {
  const { log, configPath } = fixture([measure('e1', 40), measure('e2', 30, ['e1'])]);
  const r = runCli(['replay', log, '--config', configPath]);
  assert.equal(r.code, EXIT.OK);
  const out = JSON.parse(r.stdout);
  assert.equal(out.tools.T1.state, 'cutting');
  assert.equal(out.tools.T1.used, 70);
  assert.deepEqual(out.order, ['e1', 'e2']);
});

test('replay over budget exits 12', () => {
  const { log, configPath } = fixture([measure('e1', 101)]);
  const r = runCli(['replay', log, '--config', configPath]);
  assert.equal(r.code, EXIT.BUDGET);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error.code, EXIT.BUDGET);
  assert.equal(JSON.parse(r.stdout).overspendPoint, 'e1');
});

test('replay with illegal transition exits 13', () => {
  const { log, configPath } = fixture([measure('e1', 10, ['ghost'])]);
  const r = runCli(['replay', log, '--config', configPath]);
  assert.equal(r.code, EXIT.TRANSITION);
  assert.match(r.stderr, /ghost/);
});

test('replay of incomparable concurrent history exits 14 with both ids', () => {
  const { log, configPath } = fixture([measure('e1', 60), cut('e2', 60)]);
  const r = runCli(['replay', log, '--config', configPath]);
  assert.equal(r.code, EXIT.CONFLICT);
  assert.match(r.stderr, /e1/);
  assert.match(r.stderr, /e2/);
  const err = JSON.parse(r.stderr);
  assert.deepEqual(new Set([err.error.details.a, err.error.details.b]), new Set(['e1', 'e2']));
});

test('budget prints layered consumption', () => {
  const { log, configPath } = fixture([measure('e1', 40), cut('e2', 20, ['e1'])]);
  const r = runCli(['budget', log, '--config', configPath]);
  assert.equal(r.code, EXIT.OK);
  const out = JSON.parse(r.stdout);
  const seg = out.layers.find((l) => l.kind === 'seg');
  assert.equal(seg.used, 60);
  assert.equal(seg.remaining, 140);
});

test('audit of a clean log reports ok, of a locked log exits 12 with facts', () => {
  const clean = fixture([measure('e1', 40)]);
  const okRun = runCli(['audit', clean.log, '--config', clean.configPath]);
  assert.equal(okRun.code, EXIT.OK);
  assert.equal(JSON.parse(okRun.stdout).ok, true);

  const locked = fixture([measure('e1', 40), cut('e2', 70, ['e1'])]);
  const lockedRun = runCli(['audit', locked.log, '--config', locked.configPath]);
  assert.equal(lockedRun.code, EXIT.BUDGET);
  const report = JSON.parse(lockedRun.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.overspendPoint, 'e2');
  assert.equal(report.scraps[0].event, 'e2');
});

test('audit of a conflicting log exits 14', () => {
  const { log, configPath } = fixture([measure('e1', 60), cut('e2', 60)]);
  const r = runCli(['audit', log, '--config', configPath]);
  assert.equal(r.code, EXIT.CONFLICT);
  const report = JSON.parse(r.stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(new Set([report.conflict.a, report.conflict.b]), new Set(['e1', 'e2']));
});

test('undo --target emits a compensation event, --append persists it', () => {
  const { log, configPath } = fixture([measure('e1', 40), measure('e2', 30, ['e1'])]);
  const r = runCli(['undo', log, '--target', 'e2', '--config', configPath, '--append']);
  assert.equal(r.code, EXIT.OK);
  const report = JSON.parse(r.stdout);
  assert.equal(report.compensation.target, 'e2');
  assert.equal(report.tools.T1.used, 40);
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[2]).type, 'compensate');
});

test('replay accepts a JSON array log and stdin', () => {
  const { configPath } = fixture([]);
  const r = runCli(['replay', '-', '--config', configPath], JSON.stringify([measure('e1', 10)]));
  assert.equal(r.code, EXIT.OK);
  assert.equal(JSON.parse(r.stdout).tools.T1.used, 10);
});

test('unknown command exits 2', () => {
  const r = runCli(['frobnicate']);
  assert.equal(r.code, EXIT.USAGE);
});
