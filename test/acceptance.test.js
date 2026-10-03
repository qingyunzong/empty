import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, E_BUDGET } from '../src/scheduler.js';
import { PositionalIndex, tokenize } from '../src/index.js';

// Deterministic PRNG so the randomized cross-checks are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Acceptance 1: conflict set equals brute-force all-pairs enumeration.
test('acceptance 1: conflict set matches brute-force task-pair enumeration', () => {
  const rand = mulberry32(42);
  for (let trial = 0; trial < 20; trial++) {
    const s = new Scheduler();
    const n = 2 + Math.floor(rand() * 10);
    const ids = [];
    for (let i = 0; i < n; i++) {
      const id = `T${i}`;
      const start = Math.floor(rand() * 20);
      const end = start + 1 + Math.floor(rand() * 6);
      const resources = [];
      for (const r of ['R1', 'R2', 'R3']) if (rand() < 0.5) resources.push(r);
      if (resources.length === 0) resources.push('R1');
      s.addTask({ id, resources, start, end });
      ids.push(id);
    }
    // Independent brute force.
    const brute = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = s.getTask(ids[i]);
        const b = s.getTask(ids[j]);
        const share = a.resources.some((r) => b.resources.includes(r));
        const overlap = a.start < b.end && b.start < a.end;
        if (share && overlap) brute.push([a.id, b.id]);
      }
    }
    brute.sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]));
    assert.deepEqual(s.conflicts(), brute, `trial ${trial}`);
  }
});

// Acceptance 2: phrase + window results match a brute-force token scan.
test('acceptance 2: phrase window query matches brute-force text scan', () => {
  const rand = mulberry32(7);
  const vocab = ['换', '模', '后', '延', '迟', '检', '修', 'setup', 'delay', 'ok'];
  for (let trial = 0; trial < 30; trial++) {
    const idx = new PositionalIndex();
    const docs = [];
    const nDocs = 1 + Math.floor(rand() * 8);
    for (let d = 0; d < nDocs; d++) {
      const len = 1 + Math.floor(rand() * 12);
      const text = Array.from({ length: len }, () => vocab[Math.floor(rand() * vocab.length)]).join(' ');
      const start = Math.floor(rand() * 30);
      const end = start + 1 + Math.floor(rand() * 10);
      idx.addDocument(d + 1, text, { start, end });
      docs.push({ id: d + 1, tokens: tokenize(text), start, end });
    }
    const phraseLen = 1 + Math.floor(rand() * 3);
    const phrase = Array.from({ length: phraseLen }, () => vocab[Math.floor(rand() * vocab.length)]).join(' ');
    const ws = Math.floor(rand() * 30);
    const we = ws + Math.floor(rand() * 15);
    const window = { start: ws, end: we };

    const qTokens = tokenize(phrase);
    const brute = [];
    for (const doc of docs) {
      if (!(doc.start < we && ws < doc.end)) continue;
      const hits = [];
      for (let p = 0; p + qTokens.length <= doc.tokens.length; p++) {
        if (qTokens.every((t, i) => doc.tokens[p + i] === t)) hits.push(p);
      }
      if (hits.length) brute.push({ docId: doc.id, positions: hits });
    }
    assert.deepEqual(idx.phrase(phrase, { window }), brute, `trial ${trial} phrase=${phrase}`);
  }
});

// Acceptance 3: undo blocked by budget, state intact, then redo succeeds.
test('acceptance 3: budget-blocked undo leaves state unchanged, redo then succeeds', () => {
  const s = new Scheduler({ budget: 2 });
  s.addTask({ id: 'A', resources: ['R1'], start: 0, end: 4, deadline: 1 });
  s.addTask({ id: 'D', resources: ['R1'], start: 10, end: 14, deadline: 14 });
  s.applyChange({ taskId: 'A', shift: -3 }); // A: [-3,1), delay 0
  s.applyChange({ taskId: 'D', shift: -1 }); // D: [9,13), delay 0

  const first = s.undo(); // revert D -> [10,14), delay 0, within budget
  assert.deepEqual(first.affected, ['A', 'D']);
  assert.equal(s.getTask('D').start, 10);

  // Reverting A would produce delay 3 on the affected set {A,D} > budget 2.
  assert.throws(() => s.undo(), (e) => e.code === E_BUDGET);
  assert.equal(s.getTask('A').start, -3, 'failed rollback must not move A');
  assert.equal(s.getTask('D').start, 10, 'failed rollback must not move D');
  assert.equal(s.undoStack.length, 1, 'failed rollback stays on the undo stack');
  assert.equal(s.redoStack.length, 1);

  const redone = s.redo(); // re-applies D shift
  assert.equal(s.getTask('D').start, 9);
  assert.deepEqual(redone.conflicts, []);
  assert.equal(s.redoStack.length, 0);
});

// Acceptance 4: after deleting a change note, the compressed index must not
// return false positives, and surviving documents must still match.
test('acceptance 4: deleted change note never matches via compressed postings', () => {
  const rand = mulberry32(99);
  const vocab = ['换', '模', '后', '延', '迟', '停', '机'];
  const idx = new PositionalIndex();
  const docs = new Map();
  for (let d = 1; d <= 12; d++) {
    const len = 2 + Math.floor(rand() * 10);
    const text = Array.from({ length: len }, () => vocab[Math.floor(rand() * vocab.length)]).join(' ');
    idx.addDocument(d, text, { start: d * 10, end: d * 10 + 5 });
    docs.set(d, text);
  }
  const phrase = '换 模 后';

  // Delete half of the documents.
  const deleted = [];
  for (const d of [...docs.keys()]) {
    if (rand() < 0.5) {
      assert.ok(idx.removeDocument(d));
      docs.delete(d);
      deleted.push(d);
    }
  }

  // Brute-force expectation over surviving docs only.
  const q = tokenize(phrase);
  const expected = [];
  for (const [id, text] of docs) {
    const toks = tokenize(text);
    const hits = [];
    for (let p = 0; p + q.length <= toks.length; p++) {
      if (q.every((t, i) => toks[p + i] === t)) hits.push(p);
    }
    if (hits.length) expected.push({ docId: id, positions: hits });
  }
  expected.sort((a, b) => a.docId - b.docId);
  assert.deepEqual(idx.phrase(phrase), expected);

  // No deleted doc may appear in any compressed posting of its terms.
  for (const d of deleted) {
    for (const term of vocab) {
      assert.ok(!PositionalIndex.decodeTerm(idx.encodeTerm(term)).has(d), `doc ${d} leaked via term ${term}`);
    }
  }
});
