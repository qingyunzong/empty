import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Database, STATUSES } from '../src/db.js';
import { BusinessError } from '../src/errors.js';

// Acceptance 3: enumerate operation sequences over <= 4 savepoints and check
// the library against an independent recursive DFS reference implementation.
// Compared: weights (effective), ancestor sets, and SHA256 certificates.

// ---------- independent reference implementation ----------

function refClone(state) {
  return structuredClone(state);
}

function refEffective(b) {
  return b.weight - b.consumed;
}

function refAncestors(state, id) {
  const seen = new Set();
  const walk = (cur) => {
    for (const p of state.batches.get(cur)?.parents ?? []) {
      if (!seen.has(p)) {
        seen.add(p);
        walk(p);
      }
    }
  };
  walk(id);
  return [...seen].sort();
}

function refCert(state, id, memo = new Map()) {
  if (memo.has(id)) return memo.get(id);
  const b = state.batches.get(id);
  // keys inserted in sorted order: id < parents < status < weight
  const parents = b.parents.map((p) => refCert(state, p, memo)).sort();
  const payload = JSON.stringify({ id: b.id, parents, status: b.status, weight: b.weight });
  const h = crypto.createHash('sha256').update(payload).digest('hex');
  memo.set(id, h);
  return h;
}

function refMutate(state, op) {
  const next = refClone(state);
  if (op.kind === 'split') {
    const parent = next.batches.get(op.parent);
    if (!parent) throw new BusinessError('ref: unknown parent');
    if (next.batches.has(op.child)) throw new BusinessError('ref: child exists');
    if (op.weight > refEffective(parent)) throw new BusinessError('ref: overweight');
    parent.consumed += op.weight;
    parent.children.push(op.child);
    next.batches.set(op.child, {
      id: op.child, weight: op.weight, consumed: 0, status: 'pending', parents: [op.parent], children: [],
    });
  } else if (op.kind === 'status') {
    const b = next.batches.get(op.id);
    if (!b) throw new BusinessError('ref: unknown batch');
    if (!STATUSES.includes(op.status)) throw new BusinessError('ref: bad status');
    b.status = op.status;
  } else {
    throw new Error('ref: bad op');
  }
  return next;
}

// Recursive DFS over the op trace. Purely functional: every step returns new
// (state, savepointStack) so rollback is just resuming an older continuation.
function refRun(ops) {
  const initial = {
    batches: new Map([
      ['R', { id: 'R', weight: 1000, consumed: 0, status: 'pending', parents: [], children: [] }],
    ]),
  };
  const dfs = (state, stack, i) => {
    if (i === ops.length) return state;
    const op = ops[i];
    if (op.kind === 'sp') {
      return dfs(state, [...stack, { name: op.name, snapshot: refClone(state) }], i + 1);
    }
    if (op.kind === 'rel') {
      const idx = stack.map((s) => s.name).lastIndexOf(op.name);
      if (idx < 0) throw new BusinessError('ref: unknown savepoint');
      return dfs(state, stack.slice(0, idx), i + 1); // boundary dropped, changes kept
    }
    if (op.kind === 'rb') {
      const idx = stack.map((s) => s.name).lastIndexOf(op.name);
      if (idx < 0) throw new BusinessError('ref: unknown savepoint');
      return dfs(refClone(stack[idx].snapshot), stack.slice(0, idx + 1), i + 1);
    }
    return dfs(refMutate(state, op), stack, i + 1);
  };
  return dfs(initial, [], 0);
}

// ---------- sequence generation ----------

const NAMES = ['a', 'b', 'c', 'd'];

function* sequences(maxLen) {
  const alphabet = [];
  for (const n of NAMES) {
    alphabet.push({ kind: 'sp', name: n }, { kind: 'rel', name: n }, { kind: 'rb', name: n });
  }
  alphabet.push({ kind: 'split' }, { kind: 'status' });
  function* rec(prefix, usedSavepoints) {
    yield prefix;
    if (prefix.length === maxLen) return;
    for (const op of alphabet) {
      if (op.kind === 'sp' && usedSavepoints.has(op.name)) continue; // <= 4 savepoints, each defined once
      const used = new Set(usedSavepoints);
      if (op.kind === 'sp') used.add(op.name);
      yield* rec([...prefix, op], used);
    }
  }
  yield* rec([], new Set());
}

// Deterministic mutation arguments, identical on both sides.
function concretize(ops) {
  let n = 0;
  return ops.map((op) => {
    if (op.kind === 'split') {
      n += 1;
      return {
        kind: 'split',
        parent: n % 2 === 0 ? 'R' : `c${n - 1}`,
        child: `c${n}`,
        weight: n % 5 === 4 ? 5000 : 1, // periodically exceed the weight budget
      };
    }
    if (op.kind === 'status') {
      n += 1;
      return { kind: 'status', id: n % 2 === 0 ? 'R' : `c${Math.max(1, n - 1)}`, status: STATUSES[n % STATUSES.length] };
    }
    return op;
  });
}

function applyLib(db, op) {
  switch (op.kind) {
    case 'sp': return db.savepoint(op.name);
    case 'rel': return db.release(op.name);
    case 'rb': return db.rollbackTo(op.name);
    case 'split': return db.split({ parents: [op.parent], children: [{ id: op.child, weight: op.weight }] });
    case 'status': return db.setStatus({ id: op.id, status: op.status });
    default: throw new Error('bad op');
  }
}

function normalizeLib(db) {
  const out = {};
  for (const b of db.snapshot()) {
    out[b.id] = {
      weight: b.weight,
      effective: b.effective,
      status: b.status,
      parents: [...b.parents].sort(),
      children: [...b.children].sort(),
      ancestors: db.ancestors(b.id),
      certificate: db.certificate(b.id),
    };
  }
  return out;
}

function normalizeRef(state) {
  const out = {};
  for (const [id, b] of [...state.batches.entries()].sort()) {
    out[id] = {
      weight: b.weight,
      effective: refEffective(b),
      status: b.status,
      parents: [...b.parents].sort(),
      children: [...b.children].sort(),
      ancestors: refAncestors(state, id),
      certificate: refCert(state, id),
    };
  }
  return out;
}

test('enumerated savepoint sequences match recursive DFS reference', () => {
  let count = 0;
  let errorPaths = 0;
  for (const raw of sequences(4)) {
    const ops = concretize(raw);
    count += 1;

    const db = Database.memory();
    db.begin();
    db.create({ id: 'R', weight: 1000 });

    // Reference: recursive DFS, stops at first business error (state frozen).
    let refState = null;
    let refFailedAt = -1;
    try {
      refState = refRun(ops);
    } catch (err) {
      assert.ok(err instanceof BusinessError);
      // Replay to find where it diverges is unnecessary: the library must
      // raise a business error at the same first failing op.
      for (let i = 0; i < ops.length; i++) {
        try {
          refRun(ops.slice(0, i + 1));
        } catch {
          refFailedAt = i;
          break;
        }
      }
    }

    // Library: apply step by step; a business error must occur at exactly the
    // same op, and the failed op must not corrupt the remaining sequence.
    let libFailedAt = -1;
    for (let i = 0; i < ops.length; i++) {
      try {
        applyLib(db, ops[i]);
      } catch (err) {
        assert.ok(err instanceof BusinessError, `non-business error at op ${i}: ${err}`);
        libFailedAt = i;
        break;
      }
    }

    assert.equal(
      libFailedAt,
      refFailedAt,
      `error-position mismatch for sequence ${JSON.stringify(ops)}`,
    );

    if (refFailedAt >= 0) {
      errorPaths += 1;
      db.abort();
      db.close();
      continue;
    }

    assert.deepEqual(
      normalizeLib(db),
      normalizeRef(refState),
      `state mismatch for sequence ${JSON.stringify(ops)}`,
    );
    db.abort();
    db.close();
  }
  assert.ok(count > 20000, `expected broad enumeration, got ${count}`);
  assert.ok(errorPaths > 1000, `expected many error paths, got ${errorPaths}`);
  console.log(`enumerated ${count} sequences (${errorPaths} with business errors)`);
});
