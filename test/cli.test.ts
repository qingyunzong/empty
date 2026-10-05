import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/app.js';
import type { Solution } from '../src/types.js';

const EX = join(process.cwd(), 'examples');

test('cli: solve writes a solution file and check accepts it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'depfix-'));
  const out = join(dir, 'sol.json');
  const r1 = runCli(['solve', join(EX, 'cycle.json'), '--out', out, '--verify']);
  assert.equal(r1.code, 0, r1.stderr);
  const sol = JSON.parse(readFileSync(out, 'utf8')) as Solution;
  assert.equal(sol.status, 'optimal');
  assert.equal(sol.totalCost, 1);
  assert.deepEqual(sol.deletedEdges!.map((e) => e.id), ['db-ui']);
  assert.equal(sol.proof!.enumeration!.matches, true);
  assert.match(r1.stderr, /enumeration check: MATCH/);

  const r2 = runCli(['check', join(EX, 'cycle.json'), out]);
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stdout, /valid and optimal/);
});

test('cli: solve prints to stdout without --out', () => {
  const r = runCli(['solve', join(EX, 'cycle.json')]);
  assert.equal(r.code, 0, r.stderr);
  const sol = JSON.parse(r.stdout) as Solution;
  assert.equal(sol.status, 'optimal');
  assert.equal(sol.topologicalOrder!.length, 3);
});

test('cli: locked cycle exits 1 and emits the undeletable cycle', () => {
  const r = runCli(['solve', join(EX, 'locked-cycle.json')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /locked-cycle/);
  const sol = JSON.parse(r.stdout) as Solution;
  const cyc = sol.infeasible!.cycle!;
  assert.equal(cyc[0], cyc[cyc.length - 1]);
});

test('cli: verify enumerates all subsets and matches the solution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'depfix-'));
  const out = join(dir, 'sol.json');
  const r0 = runCli(['solve', join(EX, 'app.json'), '--out', out]);
  assert.equal(r0.code, 0, r0.stderr);
  const r = runCli(['verify', join(EX, 'app.json'), '--solution', out]);
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.subsetsChecked, 2 ** report.deletableEdges);
  assert.equal(report.matches, true);
});

test('cli: app.json solution preserves main->report with a valid path certificate', () => {
  const r = runCli(['solve', join(EX, 'app.json')]);
  assert.equal(r.code, 0, r.stderr);
  const sol = JSON.parse(r.stdout) as Solution;
  const cert = sol.preservedPaths!.find((c) => c.from === 'main' && c.to === 'report')!;
  assert.equal(cert.path[0], 'main');
  assert.equal(cert.path[cert.path.length - 1], 'report');
  assert.ok(sol.totalCost! <= 10, 'within budget');
});

test('cli: check fails on a tampered solution (exit 3)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'depfix-'));
  const out = join(dir, 'sol.json');
  runCli(['solve', join(EX, 'cycle.json'), '--out', out]);
  const sol = JSON.parse(readFileSync(out, 'utf8')) as Solution;
  sol.totalCost = 0;
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify(sol));
  const r = runCli(['check', join(EX, 'cycle.json'), bad]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /INVALID/);
});

test('cli: usage and input errors', () => {
  assert.equal(runCli([]).code, 0); // prints usage
  assert.equal(runCli(['solve', join(EX, 'nope.json')]).code, 2);
  assert.equal(runCli(['bogus']).code, 2);
  assert.equal(runCli(['check', join(EX, 'cycle.json')]).code, 2);
});
