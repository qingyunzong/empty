import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Planner } from '../src/planner.js';

const snapshot = {
  machines: [{ id: 'K1', rate: 10 }, { id: 'K2', rate: 5 }],
  molds: [{ id: 'M1', machine: 'K1' }, { id: 'M2', machine: 'K2' }],
  operators: [{ id: 'P1' }, { id: 'P2' }],
  setups: [{ from: '*', to: '*', minutes: 2 }],
  orders: [
    { id: 'O1', mold: 'M1', operator: 'P1', qty: 100, due: 1000 },
    { id: 'O2', mold: 'M2', operator: 'P2', qty: 50, due: 1000 },
  ],
};

function build() {
  const dir = mkdtempSync(join(tmpdir(), 'planner-undo-'));
  const p = new Planner(dir, 'planner-0');
  p.load(snapshot);                                                    // op 1
  p.insert({ id: 'O3', mold: 'M1', operator: 'P1', qty: 30, due: 1000 }); // op 2
  p.insert({ id: 'O4', mold: 'M2', operator: 'P2', qty: 25, due: 1000 }); // op 3
  return { dir, p };
}

// Acceptance 3: undo to a midpoint, replay is consistent; restore forward works.
test('undo to midpoint then replay yields identical results', () => {
  const { dir, p } = build();
  const fullDigest = p.currentPlan().digest;

  const { plan: mid, cert } = p.undoTo(2); // back to after first insert
  assert.equal(mid.headSeq, 2);
  assert.deepEqual(mid.seq, ['O1', 'O2', 'O3']);
  assert.equal(cert.type, 'undo');
  assert.deepEqual(Object.keys(mid.commitments).sort(), ['O1', 'O2', 'O3']);

  // a fresh process replays the log to the same head and gets the same plan
  const v = new Planner(dir, 'auditor').verify();
  assert.ok(v.ok, JSON.stringify(v.checks));
  const replayed = new Planner(dir, 'auditor').currentPlan();
  assert.equal(replayed.digest, mid.digest);

  // restore forward to op 3 -> bit-identical to the original full plan
  const { plan: restored } = new Planner(dir, 'planner-0').undoTo(3);
  assert.equal(restored.digest, fullDigest);
  assert.ok(new Planner(dir, 'auditor').verify().ok);
});

test('undo certificate proves promised due dates were not altered', () => {
  const { dir, p } = build();
  const before = p.currentPlan().commitments;
  const { cert } = p.undoTo(1);
  // orders still promised at the restored point keep their original due dates
  for (const [id, due] of Object.entries(cert.commitments)) {
    assert.equal(before[id], due, `due date of ${id} changed!`);
  }
  const v = new Planner(dir, 'auditor').verify();
  const undoChecks = v.checks.filter((c) => c.name.startsWith('cert:undo'));
  assert.equal(undoChecks.length, 1);
  assert.ok(undoChecks[0].ok);
});

test('undo target validation', () => {
  const { p } = build();
  assert.throws(() => p.undoTo(99), /operation point/);
  assert.throws(() => p.undoTo(-1), /operation point/);
});
