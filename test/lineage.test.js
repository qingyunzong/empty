'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  LineageError,
  hashVersion,
  compareClocks,
  validateVersion,
  mergeVersions,
} = require('../src/lineage.js');

const CLI = path.join(__dirname, '..', 'bin', 'lineage-merge.js');

function makeVersion({ author = 'alice', clock, parents = [], fields = {}, evidence = [] }) {
  const v = { author, clock, parents, fields, evidence };
  v.hash = hashVersion(v);
  return v;
}

function storeOf(...versions) {
  return new Map(versions.map((v) => [v.hash, v]));
}

test('fast-forward: ancestor version merges to descendant without new commit', () => {
  const v1 = makeVersion({ clock: { n1: 1 }, fields: { accuracy: 0.8 } });
  const v2 = makeVersion({ clock: { n1: 2 }, parents: [v1.hash], fields: { accuracy: 0.9 } });
  const store = storeOf(v1, v2);
  validateVersion(v2, store);

  const fwd = mergeVersions(v1, v2, store);
  assert.equal(fwd.status, 'fast-forward');
  assert.equal(fwd.version.hash, v2.hash);

  const bwd = mergeVersions(v2, v1, store);
  assert.equal(bwd.status, 'fast-forward');
  assert.equal(bwd.version.hash, v2.hash);
});

test('concurrent compatible merge: disjoint fields and non-exclusive evidence', () => {
  const base = makeVersion({ clock: { n1: 1 }, fields: { accuracy: 0.8, loss: 0.4 } });
  const a = makeVersion({
    author: 'alice',
    clock: { n1: 2, n2: 1 },
    parents: [base.hash],
    fields: { accuracy: 0.85, loss: 0.4 },
    evidence: [{ id: 'ev-1', label: 'supports:h1', group: 'h1' }],
  });
  const b = makeVersion({
    author: 'bob',
    clock: { n1: 2, n2: 0, n3: 3 },
    parents: [base.hash],
    fields: { accuracy: 0.8, loss: 0.31 },
    evidence: [{ id: 'ev-2', label: 'dataset:imagenet' }],
  });
  const store = storeOf(base, a, b);
  validateVersion(a, store);
  validateVersion(b, store);

  const result = mergeVersions(a, b, store);
  assert.equal(result.status, 'merged');
  const m = result.version;
  assert.deepEqual(m.clock, { n1: 2, n2: 1, n3: 3 }); // component-wise max
  assert.deepEqual([...m.parents].sort(), [a.hash, b.hash].sort());
  assert.equal(m.fields.accuracy, 0.85); // from a
  assert.equal(m.fields.loss, 0.31); // from b
  assert.equal(m.evidence.length, 2); // union of evidence
  assert.equal(m.hash, hashVersion(m)); // lineage hash recomputed
  // merged clock strictly dominates both parents: valid in extended store
  validateVersion(m, storeOf(base, a, b, m));
});

test('conflict: mutually exclusive evidence labels produce a certificate', () => {
  const base = makeVersion({ clock: { n1: 1 } });
  const a = makeVersion({
    clock: { n1: 2 },
    parents: [base.hash],
    evidence: [{ id: 'ev-a', label: 'positive', group: 'outcome' }],
  });
  const b = makeVersion({
    clock: { n1: 1, n2: 1 },
    parents: [base.hash],
    evidence: [{ id: 'ev-b', label: 'negative', group: 'outcome' }],
  });
  const store = storeOf(base, a, b);
  const result = mergeVersions(a, b, store);
  assert.equal(result.status, 'conflict');
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].type, 'mutually-exclusive-labels');
  assert.equal(result.conflicts[0].group, 'outcome');
  assert.equal(result.conflicts[0].leftVersion, a.hash);
  assert.equal(result.conflicts[0].rightVersion, b.hash);
});

test('conflict: contradictory numeric field modified on both sides', () => {
  const base = makeVersion({ clock: { n1: 1 }, fields: { accuracy: 0.8 } });
  const a = makeVersion({ clock: { n1: 2 }, parents: [base.hash], fields: { accuracy: 0.9 } });
  const b = makeVersion({ clock: { n1: 1, n2: 1 }, parents: [base.hash], fields: { accuracy: 0.7 } });
  const result = mergeVersions(a, b, storeOf(base, a, b));
  assert.equal(result.status, 'conflict');
  assert.equal(result.conflicts[0].type, 'contradictory-numeric-field');
  assert.equal(result.conflicts[0].field, 'accuracy');
});

test('vector clocks: exhaustive enumeration vs independent partial order (dims 1-3)', () => {
  // Independent definition of the happens-before partial order.
  const leq = (a, b, keys) => keys.every((k) => (a[k] || 0) <= (b[k] || 0));
  const independentCompare = (a, b) => {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    const ab = leq(a, b, keys);
    const ba = leq(b, a, keys);
    if (ab && ba) return 0;
    if (ab) return -1;
    if (ba) return 1;
    return null;
  };

  for (let dim = 1; dim <= 3; dim++) {
    const keys = ['x', 'y', 'z'].slice(0, dim);
    const clocks = [];
    const values = [0, 1, 2];
    const combos = (i, acc) => {
      if (i === dim) return clocks.push({ ...acc });
      for (const v of values) { acc[keys[i]] = v; combos(i + 1, acc); }
    };
    combos(0, {});

    // Pairwise: compareClocks must match the independent definition.
    for (const a of clocks) {
      for (const b of clocks) {
        assert.equal(
          compareClocks(a, b),
          independentCompare(a, b),
          `mismatch for ${JSON.stringify(a)} vs ${JSON.stringify(b)}`
        );
      }
    }

    // Partial order laws, verified independently over the enumeration.
    for (const a of clocks) {
      assert.equal(compareClocks(a, a), 0); // reflexive -> equal
      for (const b of clocks) {
        // antisymmetry: a<=b and b<=a implies equal
        if (compareClocks(a, b) === -1 && compareClocks(b, a) === -1) {
          assert.fail('antisymmetry violated');
        }
        for (const c of clocks) {
          // transitivity of happens-before
          if (compareClocks(a, b) === -1 && compareClocks(b, c) === -1) {
            assert.equal(compareClocks(a, c), -1, 'transitivity violated');
          }
        }
      }
    }
  }
});

test('errors: unknown parent, clock regression, duplicate evidence id', () => {
  const v1 = makeVersion({ clock: { n1: 1 } });

  const orphan = makeVersion({ clock: { n1: 2 }, parents: ['missing-hash'] });
  assert.throws(() => validateVersion(orphan, storeOf(v1)), (e) => {
    assert.ok(e instanceof LineageError);
    assert.match(e.message, /unknown parent/);
    return true;
  });

  const regressed = makeVersion({ clock: { n1: 1 }, parents: [v1.hash] });
  assert.throws(() => validateVersion(regressed, storeOf(v1)), /clock regression/);
  const regressed2 = makeVersion({ clock: { n1: 0 }, parents: [v1.hash] });
  assert.throws(() => validateVersion(regressed2, storeOf(v1)), /clock regression/);

  const dup = makeVersion({
    clock: { n1: 1 },
    evidence: [{ id: 'ev-1' }, { id: 'ev-1' }],
  });
  assert.throws(() => validateVersion(dup, new Map()), /duplicate evidence id/);
});

function tmpStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-'));
}

function runCli(args, cwd) {
  // The sandbox drops piped stdout of spawned children, so capture via files.
  const outFile = path.join(os.tmpdir(), `cli-out-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  const errFile = outFile + '.err';
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    stdio: ['ignore', outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: r.status,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

test('CLI: compatible concurrent merge exits 0 and writes merge commit', () => {
  const dir = tmpStore();
  const base = makeVersion({ clock: { n1: 1 }, fields: { accuracy: 0.8, loss: 0.4 } });
  const a = makeVersion({ clock: { n1: 2 }, parents: [base.hash], fields: { accuracy: 0.9, loss: 0.4 } });
  const b = makeVersion({ clock: { n1: 1, n2: 1 }, parents: [base.hash], fields: { accuracy: 0.8, loss: 0.3 } });
  for (const v of [base, a, b]) {
    fs.writeFileSync(path.join(dir, `${v.hash}.json`), JSON.stringify(v));
  }
  const r = runCli(['merge', dir, a.hash, b.hash]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'merged');
  assert.ok(fs.existsSync(path.join(dir, `${out.hash}.json`)), 'merge commit written');
});

test('CLI: contradictory labels exit 2, write pairwise-conflicts.json, no merge commit', () => {
  const dir = tmpStore();
  const outDir = tmpStore();
  const base = makeVersion({ clock: { n1: 1 } });
  const a = makeVersion({
    clock: { n1: 2 },
    parents: [base.hash],
    evidence: [{ id: 'ev-a', label: 'positive', group: 'outcome' }],
  });
  const b = makeVersion({
    clock: { n1: 1, n2: 1 },
    parents: [base.hash],
    evidence: [{ id: 'ev-b', label: 'negative', group: 'outcome' }],
  });
  for (const v of [base, a, b]) {
    fs.writeFileSync(path.join(dir, `${v.hash}.json`), JSON.stringify(v));
  }
  const before = fs.readdirSync(dir).length;
  const r = runCli(['merge', dir, a.hash, b.hash, '--out', outDir]);
  assert.equal(r.status, 2, r.stderr);
  const cert = JSON.parse(fs.readFileSync(path.join(outDir, 'pairwise-conflicts.json'), 'utf8'));
  assert.equal(cert.kind, 'pairwise-conflicts');
  assert.equal(cert.conflicts[0].type, 'mutually-exclusive-labels');
  assert.equal(fs.readdirSync(dir).length, before, 'no merge commit generated');
});

test('CLI: validation errors exit 1', () => {
  const dir = tmpStore();
  const v1 = makeVersion({ clock: { n1: 1 } });
  fs.writeFileSync(path.join(dir, `${v1.hash}.json`), JSON.stringify(v1));

  // unknown parent
  const orphan = makeVersion({ clock: { n1: 2 }, parents: ['missing-hash'] });
  const orphanFile = path.join(dir, 'orphan-input.json');
  fs.writeFileSync(orphanFile, JSON.stringify(orphan));
  assert.equal(runCli(['add', dir, orphanFile]).status, 1);

  // clock regression
  const regressed = makeVersion({ clock: { n1: 1 }, parents: [v1.hash] });
  const regFile = path.join(dir, 'regressed-input.json');
  fs.writeFileSync(regFile, JSON.stringify(regressed));
  assert.equal(runCli(['add', dir, regFile]).status, 1);

  // duplicate evidence id
  const dup = makeVersion({ clock: { n1: 2 }, parents: [v1.hash], evidence: [{ id: 'e' }, { id: 'e' }] });
  const dupFile = path.join(dir, 'dup-input.json');
  fs.writeFileSync(dupFile, JSON.stringify(dup));
  assert.equal(runCli(['add', dir, dupFile]).status, 1);

  // merge against unknown version hash
  assert.equal(runCli(['merge', dir, v1.hash, 'nope']).status, 1);
});
