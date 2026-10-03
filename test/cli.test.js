import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../cli.js';

const SPEC = {
  budget: 6,
  targets: ['report.out'],
  tasks: [
    { name: 't1', cost: 2, produces: [{ name: 'raw.data', type: 'dataset' }] },
    { name: 't2', cost: 2, produces: [{ name: 'alt.data', type: 'dataset' }] },
    { name: 't3', cost: 2, produces: [{ name: 'report.out', type: 'file' }], requires: 'dataset:raw.data' },
    { name: 't4', cost: 2, produces: [{ name: 'report.out', type: 'file' }], requires: 'alt.data' },
  ],
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'planner-cli-'));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(SPEC));
  return dir;
}

test('CLI plan prints plan JSON, certificate and version', () => {
  const dir = setup();
  const r = run(['plan', join(dir, 'spec.json'), '--store', join(dir, 's.json')]);
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.ok, true);
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.plan.plans, [['t1', 't2', 't3'], ['t1', 't2', 't4']]);
  assert.match(doc.certificate.sha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof doc.certificate.canonical, 'string');
});

test('CLI revise creates a new version and keeps the old one', () => {
  const dir = setup();
  const store = join(dir, 's.json');
  run(['plan', join(dir, 'spec.json'), '--store', store]);
  const r = run(['revise', store, '--version', '1', '--task', 't1', '--cost', '5']);
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.version, 2);
  assert.deepEqual(doc.plan.plans, [['t2', 't4']]);
  const persisted = JSON.parse(readFileSync(store, 'utf8'));
  assert.equal(persisted.versions.length, 2);
  assert.equal(persisted.versions[0].tasks.find((t) => t.name === 't1').cost, 2, 'old version preserved');
});

test('CLI infeasible budget exits non-zero and writes no store', () => {
  const dir = setup();
  writeFileSync(join(dir, 'low.json'), JSON.stringify({ ...SPEC, budget: 3 }));
  const store = join(dir, 'nope.json');
  const r = run(['plan', join(dir, 'low.json'), '--store', store]);
  assert.notEqual(r.code, 0);
  assert.equal(JSON.parse(r.stderr).error.code, 'E_NO_FEASIBLE');
  assert.equal(existsSync(store), false, 'no half-built plan persisted');
});

test('CLI static type-mismatch error leaves the store unchanged', () => {
  const dir = setup();
  const store = join(dir, 's.json');
  run(['plan', join(dir, 'spec.json'), '--store', store]);
  const bad = structuredClone(SPEC);
  bad.tasks[2].requires = 'metric:report.out';
  writeFileSync(join(dir, 'bad.json'), JSON.stringify(bad));
  const r = run(['plan', join(dir, 'bad.json'), '--store', store]);
  assert.notEqual(r.code, 0);
  assert.equal(JSON.parse(r.stderr).error.code, 'E_TYPE_MISMATCH');
  assert.equal(JSON.parse(readFileSync(store, 'utf8')).versions.length, 1, 'version count unchanged');
});
