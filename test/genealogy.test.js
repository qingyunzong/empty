import test from 'node:test';
import assert from 'node:assert/strict';
import { Genealogy, makeCorrection } from '../src/genealogy.js';
import { PhraseIndex, tokenize } from '../src/phrase-index.js';
import { E_CYCLE, E_TIME, E_PROOF } from '../src/errors.js';

const NOTES = {
  M1: 'pine wood rough sawn',
  M2: 'oak wood kiln dried',
  M3: 'steel screws zinc plated',
  I1: 'wood panel from pine and oak',
  I2: 'frame with oak and steel',
  F1: 'final chair assembly',
};

function buildSample() {
  const g = new Genealogy();
  let ts = 0;
  for (const id of ['M1', 'M2', 'M3', 'I1', 'I2', 'F1']) {
    g.append({ type: 'add', id, note: NOTES[id], ts: ++ts });
  }
  const edges = [
    ['I1', 'M1'],
    ['I1', 'M2'],
    ['I2', 'M2'],
    ['I2', 'M3'],
    ['F1', 'I1'],
    ['F1', 'I2'],
  ];
  for (const [child, parent] of edges) {
    g.append({ type: 'edge', child, parent, ts: ++ts });
  }
  return g;
}

function bruteForce(edges, startId, fromKey, toKey) {
  const adjacency = new Map();
  for (const [child, parent] of edges) {
    const from = fromKey === 'child' ? child : parent;
    const to = toKey === 'child' ? child : parent;
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    adjacency.get(from).add(to);
  }
  const found = new Set();
  const stack = [...(adjacency.get(startId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop();
    if (found.has(current)) continue;
    found.add(current);
    for (const next of adjacency.get(current) ?? []) stack.push(next);
  }
  return [...found].sort();
}

const SAMPLE_EDGES = [
  ['I1', 'M1'],
  ['I1', 'M2'],
  ['I2', 'M2'],
  ['I2', 'M3'],
  ['F1', 'I1'],
  ['F1', 'I2'],
];

test('acceptance 1: ancestors/descendants match brute force, index filters cross-check', () => {
  const g = buildSample();

  for (const id of Object.keys(NOTES)) {
    assert.deepEqual(g.ancestors(id).results, bruteForce(SAMPLE_EDGES, id, 'child', 'parent'), `ancestors(${id})`);
    assert.deepEqual(g.descendants(id).results, bruteForce(SAMPLE_EDGES, id, 'parent', 'child'), `descendants(${id})`);
  }
  assert.deepEqual(g.ancestors('F1').results, ['I1', 'I2', 'M1', 'M2', 'M3']);
  assert.deepEqual(g.descendants('M2').results, ['F1', 'I1', 'I2']);

  const index = PhraseIndex.fromState(g.stateAt());

  const naivePhrase = (query) => {
    const terms = tokenize(query);
    return Object.entries(NOTES)
      .filter(([, note]) => {
        const tokens = tokenize(note);
        for (let i = 0; i + terms.length <= tokens.length; i++) {
          if (terms.every((t, j) => tokens[i + j] === t)) return true;
        }
        return false;
      })
      .map(([id]) => id)
      .sort();
  };
  for (const query of ['oak', 'pine and oak', 'wood', 'steel screws zinc', 'not present']) {
    assert.deepEqual(index.phrase(query), naivePhrase(query), `phrase "${query}"`);
  }
  assert.deepEqual(index.phrase('pine and oak'), ['I1']);
  assert.deepEqual(index.phrase('and oak'), ['I1']);

  const naiveNear = (a, b, k) =>
    Object.entries(NOTES)
      .filter(([, note]) => {
        const tokens = tokenize(note);
        return tokens.some((t, i) => t === a && tokens.some((u, j) => u === b && Math.abs(i - j) <= k));
      })
      .map(([id]) => id)
      .sort();
  for (const k of [1, 2, 3]) {
    assert.deepEqual(index.near(['pine', 'oak'], k), naiveNear('pine', 'oak', k), `NEAR/${k} pine oak`);
  }
  assert.deepEqual(index.near(['pine', 'oak'], 3), ['I1']);
  assert.deepEqual(index.near(['pine', 'oak'], 1), []);
  assert.deepEqual(index.near(['steel', 'oak'], 3), ['I2']);

  const descendantsOfF1Materials = g.descendants('M3').results;
  const steelHits = index.phrase('steel');
  assert.deepEqual(
    steelHits.filter((id) => descendantsOfF1Materials.includes(id)),
    ['I2']
  );
});

test('acceptance 2: parent correction keeps old snapshot, updates new snapshot, logs compensation', () => {
  const g = buildSample();
  g.append({ type: 'add', id: 'I3', note: 'bamboo panel alternative', ts: 13 });
  const snapshotTs = g.lastTs;
  const before = g.ancestors('F1', snapshotTs);

  const correction = makeCorrection('F1', 'I1', 'I3', 14);
  g.append(correction);

  assert.deepEqual(g.ancestors('F1', snapshotTs), before, 'old time slice must be unchanged');
  assert.deepEqual(before.results, ['I1', 'I2', 'M1', 'M2', 'M3']);

  const after = g.ancestors('F1');
  assert.deepEqual(after.results, ['I2', 'I3', 'M2', 'M3'], 'new slice reflects corrected parent');
  assert.ok(!after.results.includes('I1'));
  assert.ok(!after.results.includes('M1'));

  const logged = g.records.find((r) => r.type === 'correct');
  assert.deepEqual(logged.compensation, [
    { op: 'revoke', child: 'F1', parent: 'I1' },
    { op: 'add', child: 'F1', parent: 'I3' },
  ]);

  const pending = g.ancestors('F1', 13);
  assert.deepEqual(pending.results, before.results, 'pending correction must not break earlier slices');
});

test('acceptance 3: deletion masks descendant queries but certificate proves deletion', () => {
  const g = buildSample();
  g.append({ type: 'delete', id: 'I1', ts: 13 });

  const fromM1 = g.descendants('M1');
  assert.deepEqual(fromM1.results, [], 'descendants of M1 are masked through deleted I1');

  const fromM2 = g.descendants('M2');
  assert.deepEqual(fromM2.results, ['I2'], 'I1 and F1 masked, I2 still visible');

  const deletedQuery = g.descendants('I1');
  assert.equal(deletedQuery.masked, true, 'querying a deleted batch reports masked');
  assert.deepEqual(deletedQuery.results, []);

  const cert = g.certificate('I1');
  assert.equal(cert.tombstone, 1, 'certificate carries tombstone bit');
  assert.ok(g.verifyCertificate('I1', cert), 'deletion certificate verifies');

  const liveCert = g.certificate('M2');
  assert.equal(liveCert.tombstone, 0);

  const oldSlice = g.descendants('M1', 12);
  assert.deepEqual(oldSlice.results, ['F1', 'I1'], 'pre-deletion slice unaffected');
});

test('acceptance 4: cycle and out-of-order time raise E_CYCLE and E_TIME', () => {
  const g = new Genealogy();
  g.append({ type: 'edge', child: 'B', parent: 'A', ts: 1 });
  g.append({ type: 'edge', child: 'C', parent: 'B', ts: 2 });
  assert.throws(() => g.append({ type: 'edge', child: 'A', parent: 'C', ts: 3 }), (err) => {
    assert.equal(err.code, E_CYCLE);
    return true;
  });
  assert.throws(() => g.append({ type: 'edge', child: 'A', parent: 'A', ts: 3 }), (err) => {
    assert.equal(err.code, E_CYCLE);
    return true;
  });
  assert.throws(() => g.append(makeCorrection('A', 'X', 'C', 3)), (err) => {
    assert.equal(err.code, E_CYCLE);
    return true;
  });
  assert.throws(() => g.append({ type: 'add', id: 'Z', note: '', ts: 1 }), (err) => {
    assert.equal(err.code, E_TIME);
    return true;
  });
  assert.equal(g.lastTs, 2, 'rejected records are not appended');
});

test('inclusion proof verifies and tampering raises E_PROOF', () => {
  const g = buildSample();
  const proof = g.inclusionProof('I1');
  assert.ok(Genealogy.verifyInclusion(proof));
  assert.equal(proof.certificate.tombstone, 0);

  const tamperedRoot = { ...proof, root: '0'.repeat(64) };
  assert.throws(() => Genealogy.verifyInclusion(tamperedRoot), (err) => {
    assert.equal(err.code, E_PROOF);
    return true;
  });

  const tamperedRecord = { ...proof, record: { ...proof.record, note: 'forged' } };
  assert.throws(() => Genealogy.verifyInclusion(tamperedRecord), (err) => {
    assert.equal(err.code, E_PROOF);
    return true;
  });

  const tamperedCert = {
    ...proof,
    certificate: { ...proof.certificate, tombstone: 1 },
  };
  assert.throws(() => Genealogy.verifyInclusion(tamperedCert), (err) => {
    assert.equal(err.code, E_PROOF);
    return true;
  });

  assert.throws(() => g.inclusionProof('NOPE'), (err) => {
    assert.equal(err.code, E_PROOF);
    return true;
  });
});
