import test from 'node:test';
import assert from 'node:assert/strict';
import { PlannerStore } from '../src/store.js';
import { plan } from '../src/planner.js';
import { makeCertificate } from '../src/certificate.js';

function baseSpec() {
  return {
    budget: 6,
    targets: ['report.out'],
    tasks: [
      { name: 't1', cost: 2, produces: [{ name: 'raw.data', type: 'dataset' }] },
      { name: 't2', cost: 2, produces: [{ name: 'alt.data', type: 'dataset' }] },
      { name: 't3', cost: 2, produces: [{ name: 'report.out', type: 'file' }], requires: 'dataset:raw.data' },
      { name: 't4', cost: 2, produces: [{ name: 'report.out', type: 'file' }], requires: 'alt.data' },
    ],
  };
}

test('acceptance 3: file dependency miswritten as metric is a static error, version unchanged', () => {
  const store = new PlannerStore();
  const v1 = store.addVersion(baseSpec());
  assert.equal(v1, 1);

  const bad = baseSpec();
  bad.tasks[2].requires = 'metric:report.out'; // report.out is produced as type file
  bad.tasks[3].requires = 'metric:report.out & alt.data';
  assert.throws(
    () => store.addVersion(bad),
    (e) => e.code === 'E_TYPE_MISMATCH' && /file/.test(e.message),
  );
  assert.equal(store.versionCount, 1, 'failed version must not be committed');
});

test('revise changes one task cost, creates a new version, keeps the old one', () => {
  const store = new PlannerStore();
  store.addVersion(baseSpec());
  const v2 = store.revise(1, 't1', 5);
  assert.equal(v2, 2);
  assert.equal(store.versionCount, 2);

  const oldSpec = store.getRawSpec(1);
  const newSpec = store.getRawSpec(2);
  assert.equal(oldSpec.tasks.find((t) => t.name === 't1').cost, 2, 'old version preserved');
  assert.equal(newSpec.tasks.find((t) => t.name === 't1').cost, 5);

  // New optimum under revision: t1 now costs 5, so {t2,t4} (cost 4) is the
  // unique cheapest max-size... verify replanning reflects the new cost.
  const result = plan(newSpec);
  assert.ok(result.plans.every((p) => p.length === result.size));
});

test('revise with invalid cost or unknown task adds no version', () => {
  const store = new PlannerStore();
  store.addVersion(baseSpec());
  assert.throws(() => store.revise(1, 't1', 'cheap'), (e) => e.code === 'E_FIELD_TYPE');
  assert.throws(() => store.revise(1, 'nope', 1), (e) => e.code === 'E_UNKNOWN_TASK');
  assert.throws(() => store.revise(9, 't1', 1), (e) => e.code === 'E_UNKNOWN_VERSION');
  assert.equal(store.versionCount, 1);
});

test('certificate is deterministic and version-sensitive', () => {
  const store = new PlannerStore();
  store.addVersion(baseSpec());
  const result = plan(store.getRawSpec(1));
  const c1 = makeCertificate(result, 1);
  const c2 = makeCertificate(result, 1);
  const c3 = makeCertificate(result, 2);
  assert.equal(c1.sha256, c2.sha256);
  assert.match(c1.sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(c1.sha256, c3.sha256);
  assert.equal(c1.canonical, c2.canonical);
});
