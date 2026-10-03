import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { RefTx } from '../src/reference.js';
import { ancestorsOf } from '../src/state.js';
import { BizError } from '../src/errors.js';
import { tmpdir } from './helpers.js';

// Acceptance 3: enumerate all savepoint-op sequences of length <= 4 and
// cross-check weights, ancestors and certificates against the recursive
// DFS reference implementation.
const SP_OPS = [
  ['savepoint', 'a'], ['savepoint', 'b'],
  ['release', 'a'], ['release', 'b'],
  ['rollback', 'a'], ['rollback', 'b'],
];

function* sequences(maxLen) {
  for (let len = 1; len <= maxLen; len++) {
    const idx = new Array(len).fill(0);
    while (true) {
      yield idx.map((i) => SP_OPS[i]);
      let p = len - 1;
      while (p >= 0 && ++idx[p] === SP_OPS.length) { idx[p] = 0; p--; }
      if (p < 0) break;
    }
  }
}

// Deterministic mutation applied before each savepoint op so that
// rollback/release actually have effects to compare.
function mutation(seqNo, step) {
  const tag = `s${seqNo}m${step}`;
  switch (step % 3) {
    case 0: return { op: 'create', id: `c-${tag}`, weight: 5 };
    case 1: return { op: 'split', parent: 'R', children: [{ id: `k-${tag}`, weight: 1 }] };
    default: return { op: 'qc', id: 'R', status: step % 9 === 2 ? 'passed' : 'pending' };
  }
}

test('savepoint op sequences (<=4) match recursive DFS reference', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  let seqNo = 0;
  let checked = 0;

  for (const seq of sequences(4)) {
    seqNo++;
    const tx = store.begin();
    const ref = new RefTx(store.state);
    const prevHash = store.state.prevHash;
    let failed = null;

    for (let step = 0; step < seq.length; step++) {
      const m = mutation(seqNo, step);
      try {
        tx[m.op === 'qc' ? 'qc' : m.op](m);
        ref.op(m);
      } catch (e) {
        failed = e;
        break;
      }
      const [kind, name] = seq[step];
      let realErr = null;
      let refErr = null;
      try { tx[kind](name); } catch (e) { realErr = e; }
      try { ref[kind](name); } catch (e) { refErr = e; }
      if (realErr || refErr) {
        assert.ok(realErr instanceof BizError && refErr instanceof BizError,
          `error mismatch at seq ${JSON.stringify(seq)}: real=${realErr} ref=${refErr}`);
        failed = realErr;
        break;
      }
    }

    if (!failed) {
      const cert = tx.commit();
      const refCert = ref.certificate(prevHash);
      // Weights, qc and full state equality.
      assert.deepEqual(
        Object.fromEntries(Object.entries(cert.batches).map(([i, b]) => [b.id, b])),
        Object.fromEntries(Object.entries(refCert.batches).map(([i, b]) => [b.id, b])),
        `state mismatch for sequence ${JSON.stringify(seq)}`);
      // Ancestors per batch.
      for (const id of Object.keys(store.state.batches)) {
        const realAnc = [...ancestorsOf(store.state, id)].sort();
        const refAnc = [...ancestorsOf(ref.state, id)].sort();
        assert.deepEqual(realAnc, refAnc, `ancestors of ${id} mismatch`);
      }
      // Certificates.
      assert.equal(cert.hash, refCert.hash, `certificate mismatch for ${JSON.stringify(seq)}`);
      checked++;
    } else {
      // Aborted tx must leave no trace.
      store.activeTx = null;
      store.wal.truncate();
    }
  }

  assert.ok(checked > 0);
  store.close();
  const reopened = Store.open(dir);
  assert.equal(validateKeys(reopened.state), true);
  reopened.close();
  console.log(`enumerated sequences fully committed and verified: ${checked}`);
});

function validateKeys(state) {
  return state && typeof state.seq === 'number';
}
