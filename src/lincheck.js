import { canonical } from './model.js';

export class LinError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LinError';
    this.code = code;
    this.details = details;
  }
}

// Log format: { events: [...] }
//   commit: { type:'commit', id, processId, clock, deps:[eventId...], ops:[{op,key,value?}] }
//   read:   { type:'read',   id,processId, clock, deps:[eventId...], view:{key:value,...} }
// happens-before: same processId ordered by integer clock, plus explicit deps.
// A history is linearizable iff some topological order of the commits
// (extending happens-before) lets every read observe exactly the asserted
// rows produced by some prefix cut of that order. Concurrent (incomparable)
// batches are never ordered arbitrarily by fiat: all orders are searched.
export function checkLinearizable(log) {
  const events = log && log.events;
  if (!Array.isArray(events)) throw new LinError('E_BAD_BATCH', 'log must have an events array');
  const byId = new Map();
  for (const e of events) {
    if (!e || typeof e.id !== 'string') throw new LinError('E_BAD_BATCH', 'event missing string id');
    if (byId.has(e.id)) throw new LinError('E_BAD_BATCH', `duplicate event id ${e.id}`);
    if (e.type !== 'commit' && e.type !== 'read') {
      throw new LinError('E_BAD_BATCH', `unknown event type ${e.type}`);
    }
    if (typeof e.processId !== 'string' || !Number.isInteger(e.clock)) {
      throw new LinError('E_BAD_BATCH', `event ${e.id} needs processId (string) and clock (integer)`);
    }
    byId.set(e.id, e);
  }

  const preds = new Map(events.map((e) => [e.id, new Set()]));
  for (const e of events) {
    for (const d of e.deps ?? []) {
      if (!byId.has(d)) {
        throw new LinError('E_ORPHAN', `event ${e.id} depends on unknown event ${d}`, { dep: d });
      }
      preds.get(e.id).add(d);
    }
  }
  const byProc = new Map();
  for (const e of events) {
    const l = byProc.get(e.processId) ?? [];
    l.push(e);
    byProc.set(e.processId, l);
  }
  for (const list of byProc.values()) {
    for (const a of list) for (const b of list) if (a.clock < b.clock) preds.get(b.id).add(a.id);
  }

  // cycle check (Kahn)
  {
    const indeg = new Map(events.map((e) => [e.id, preds.get(e.id).size]));
    const succ = new Map(events.map((e) => [e.id, []]));
    for (const [id, ps] of preds) for (const p of ps) succ.get(p).push(id);
    const queue = events.filter((e) => indeg.get(e.id) === 0).map((e) => e.id);
    let seen = 0;
    while (queue.length) {
      const id = queue.pop();
      seen++;
      for (const s of succ.get(id)) {
        indeg.set(s, indeg.get(s) - 1);
        if (indeg.get(s) === 0) queue.push(s);
      }
    }
    if (seen !== events.length) {
      return { linearizable: false, code: 'E_NONLINEAR', reason: 'happens-before cycle detected' };
    }
  }

  const commits = events.filter((e) => e.type === 'commit');
  const reads = events.filter((e) => e.type === 'read');
  for (const c of commits) {
    if (!Array.isArray(c.ops)) throw new LinError('E_BAD_BATCH', `commit ${c.id} needs ops array`);
    for (const op of c.ops) {
      if (!op || typeof op.key !== 'string' || (op.op !== 'assert' && op.op !== 'retract')) {
        throw new LinError('E_BAD_BATCH', `commit ${c.id} has invalid op ${JSON.stringify(op)}`);
      }
    }
  }
  for (const r of reads) {
    if (!r.view || typeof r.view !== 'object' || Array.isArray(r.view)) {
      throw new LinError('E_BAD_BATCH', `read ${r.id} needs a view object`);
    }
  }

  // transitive closure of happens-before (ancestors / descendants per event)
  const anc = new Map();
  const computeAnc = (id) => {
    if (anc.has(id)) return anc.get(id);
    const out = new Set();
    anc.set(id, out); // guard (graph is acyclic here)
    for (const p of preds.get(id)) {
      out.add(p);
      for (const q of computeAnc(p)) out.add(q);
    }
    return out;
  };
  const desc = new Map();
  const succOf = new Map(events.map((e) => [e.id, []]));
  for (const [id, ps] of preds) for (const p of ps) succOf.get(p).push(id);
  const computeDesc = (id) => {
    if (desc.has(id)) return desc.get(id);
    const out = new Set();
    desc.set(id, out);
    for (const s of succOf.get(id)) {
      out.add(s);
      for (const q of computeDesc(s)) out.add(q);
    }
    return out;
  };

  const n = commits.length;
  const cIndex = new Map(commits.map((c, i) => [c.id, i]));
  let commitPred = commits.map((c) => {
    let m = 0n;
    for (const a of computeAnc(c.id)) {
      const i = cIndex.get(a);
      if (i !== undefined) m |= 1n << BigInt(i);
    }
    return m;
  });
  const readInfo = reads.map((r) => {
    let inc = 0n;
    let exc = 0n;
    for (const a of computeAnc(r.id)) {
      const i = cIndex.get(a);
      if (i !== undefined) inc |= 1n << BigInt(i);
    }
    for (const d of computeDesc(r.id)) {
      const i = cIndex.get(d);
      if (i !== undefined) exc |= 1n << BigInt(i);
    }
    const viewCanon = new Map();
    for (const [k, v] of Object.entries(r.view)) viewCanon.set(k, canonical(v));
    return { id: r.id, inc, exc, viewCanon };
  });

  // Canonical form of every commit op, computed once.
  const commitOps = commits.map((c) =>
    c.ops.map((op) =>
      op.op === 'assert'
        ? { key: op.key, assert: true, value: op.value ?? null, canon: canonical(op.value ?? null) }
        : { key: op.key, assert: false }
    )
  );
  // Per read and observed key: commits that could still make the key hold the
  // observed value ("saviors"). If every savior is already placed or forbidden
  // while the current state disagrees, the read is doomed on this path.
  for (const ri of readInfo) {
    ri.saviors = new Map();
    for (const [k, vc] of ri.viewCanon) {
      let m = 0n;
      for (let i = 0; i < n; i++) {
        const bit = 1n << BigInt(i);
        if (ri.exc & bit) continue;
        if (commitOps[i].some((op) => op.assert && op.key === k && op.canon === vc)) m |= bit;
      }
      ri.saviors.set(k, m);
    }
  }
  // Per key: commits retracting it (used to check an asserted key can still disappear)
  const retractors = new Map();
  for (let i = 0; i < n; i++) {
    for (const op of commitOps[i]) {
      if (op.assert) continue;
      if (!retractors.has(op.key)) retractors.set(op.key, 0n);
      retractors.set(op.key, retractors.get(op.key) | (1n << BigInt(i)));
    }
  }

  // cheap refutation: a read can never observe a value no commit asserts
  const assertedValues = new Map();
  for (const c of commits) {
    for (const op of c.ops) {
      if (op.op !== 'assert') continue;
      if (!assertedValues.has(op.key)) assertedValues.set(op.key, new Set());
      assertedValues.get(op.key).add(canonical(op.value ?? null));
    }
  }
  for (const ri of readInfo) {
    for (const [k, vc] of ri.viewCanon) {
      if (!assertedValues.get(k)?.has(vc)) {
        return {
          linearizable: false,
          code: 'E_NONLINEAR',
          reason: `read ${ri.id} observes value never asserted for key ${k}`,
          witness: ri.id,
        };
      }
    }
  }

  // Derive extra ordering constraints from the reads. If key k must hold
  // value v at read r's cut and exactly one commit w (outside r's successors)
  // can leave k = v, then every k-writer forced into the cut (in inc(r)) that
  // leaves a different value must be ordered before w. Likewise, a key that
  // must be absent at the cut but is asserted inside inc(r) needs a retract
  // after every such assert; with no available retractor the read is
  // impossible; with exactly one, all those asserts precede it.
  {
    const extra = commits.map(() => new Set()); // extra[i] = commits that must precede i
    const incSets = readInfo.map((ri) => {
      const set = new Set();
      for (let i = 0; i < n; i++) if ((ri.inc & (1n << BigInt(i))) !== 0n) set.add(i);
      return set;
    });
    const writesKey = commits.map((c, i) => {
      const m = new Map();
      for (const op of commitOps[i]) m.set(op.key, op);
      return m;
    });
    for (let r = 0; r < readInfo.length; r++) {
      const ri = readInfo[r];
      const inc = incSets[r];
      for (const [k, vc] of ri.viewCanon) {
        const saviors = [];
        for (let i = 0; i < n; i++) if ((ri.saviors.get(k) & (1n << BigInt(i))) !== 0n) saviors.push(i);
        if (saviors.length === 1) {
          const w = saviors[0];
          for (const u of inc) {
            if (u !== w && writesKey[u].has(k)) extra[w].add(u);
          }
        }
      }
      // keys that must be absent at the cut
      const assertedInInc = new Map(); // key -> [commit indices in inc asserting it]
      for (const u of inc) {
        for (const op of commitOps[u]) {
          if (!op.assert || ri.viewCanon.has(op.key)) continue;
          if (!assertedInInc.has(op.key)) assertedInInc.set(op.key, []);
          assertedInInc.get(op.key).push(u);
        }
      }
      for (const [k, users] of assertedInInc) {
        const zmask = (retractors.get(k) ?? 0n) & ~ri.exc;
        const zs = [];
        for (let i = 0; i < n; i++) if ((zmask & (1n << BigInt(i))) !== 0n) zs.push(i);
        if (zs.length === 0) {
          return {
            linearizable: false,
            code: 'E_NONLINEAR',
            reason: `read ${ri.id} requires key ${k} absent but no usable retract exists`,
            witness: ri.id,
          };
        }
        if (zs.length === 1) {
          for (const u of users) extra[zs[0]].add(u);
        }
      }
    }
    // fold extra edges into commitPred and recompute the transitive closure
    // over commits; a cycle means the derived constraints are unsatisfiable
    const predSets = commits.map((c, i) => {
      const set = new Set();
      for (let j = 0; j < n; j++) if ((commitPred[i] & (1n << BigInt(j))) !== 0n) set.add(j);
      for (const j of extra[i]) set.add(j);
      return set;
    });
    const closureOf = (start) => {
      const out = new Set();
      const stack = [start];
      while (stack.length) {
        const x = stack.pop();
        for (const y of predSets[x]) {
          if (!out.has(y)) {
            out.add(y);
            stack.push(y);
          }
        }
      }
      return out;
    };
    for (let i = 0; i < n; i++) {
      const cl = closureOf(i);
      if (cl.has(i)) {
        return {
          linearizable: false,
          code: 'E_NONLINEAR',
          reason: 'ordering constraints derived from reads are cyclic',
        };
      }
      let m = 0n;
      for (const j of cl) m |= 1n << BigInt(j);
      commitPred[i] = m;
    }
  }

  const allCommits = (1n << BigInt(n)) - 1n;
  const allReads = (1n << BigInt(reads.length)) - 1n;
  const state = new Map(); // key -> canonical asserted value (absent = retracted/unknown)
  const undoStack = [];
  const applyCommit = (i) => {
    let count = 0;
    for (const op of commitOps[i]) {
      undoStack.push([op.key, state.get(op.key)]);
      if (op.assert) state.set(op.key, op.canon);
      else state.delete(op.key);
      count++;
    }
    return count;
  };
  const undoCommit = (count) => {
    for (; count > 0; count--) {
      const [k, prev] = undoStack.pop();
      if (prev === undefined) state.delete(k);
      else state.set(k, prev);
    }
  };
  const viewEquals = (viewCanon) => {
    if (viewCanon.size !== state.size) return false;
    for (const [k, vc] of viewCanon) {
      if (state.get(k) !== vc) return false;
    }
    return true;
  };
  const readMatches = (ri, placed) =>
    (ri.inc & ~placed) === 0n && (ri.exc & placed) === 0n && viewEquals(ri.viewCanon);

  // Kahn-style readiness tracking: avoids rescanning all commits per node
  const commitSucc = commits.map(() => []);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j && (commitPred[j] & (1n << BigInt(i))) !== 0n) commitSucc[i].push(j);
    }
  }
  const predCount = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (let j = 0; j < n; j++) if ((commitPred[i] & (1n << BigInt(j))) !== 0n) c++;
    predCount[i] = c;
  }
  const isPlaced = new Uint8Array(n);

  // The materialized state depends on the application ORDER of concurrent
  // commits (last writer wins per key), not just on the placed set, so the
  // failure memo must key on the state signature as well.
  const stateSig = () => {
    const keys = [...state.keys()].sort();
    let sig = '';
    for (const k of keys) sig += k.length + ':' + k + '=' + state.get(k) + ';';
    return sig;
  };
  // Dominance memo: from a given (placed, state) the future is identical
  // regardless of path, and a larger satisfied-read set is strictly better.
  // Failing with satisfied set T therefore also refutes any T' subset of T.
  const failed = new Map(); // key -> bigint[] of satisfied masks
  const isRefuted = (key, satisfied) => {
    const list = failed.get(key);
    if (!list) return false;
    for (const t of list) if ((t & satisfied) === satisfied) return true;
    return false;
  };
  const recordFailure = (key, satisfied) => {
    let list = failed.get(key);
    if (!list) failed.set(key, (list = []));
    for (let i = list.length - 1; i >= 0; i--) {
      if ((list[i] & satisfied) === list[i]) list.splice(i, 1); // new one dominates
    }
    list.push(satisfied);
  };
  const order = [];
  let solution = null;
  let nodes = 0;
  const dfs = (placed, satisfied) => {
    // reads are free to satisfy and never constrain the future: take them all
    for (let r = 0; r < readInfo.length; r++) {
      const bit = 1n << BigInt(r);
      if (!(satisfied & bit) && readMatches(readInfo[r], placed)) satisfied |= bit;
    }
    if (placed === allCommits) {
      if (satisfied === allReads) {
        solution = [...order];
        return true;
      }
      return false;
    }
    // doom pruning: an unsatisfied read whose requirements can no longer be met
    for (let r = 0; r < readInfo.length; r++) {
      const ri = readInfo[r];
      const rbit = 1n << BigInt(r);
      if (satisfied & rbit) continue;
      if ((ri.exc & placed) !== 0n) return false; // a successor of the read is already placed
      for (const [k, vc] of ri.viewCanon) {
        if (state.get(k) !== vc && (ri.saviors.get(k) & ~placed) === 0n) return false;
      }
      for (const k of state.keys()) {
        if (ri.viewCanon.has(k)) continue;
        const saviors = (retractors.get(k) ?? 0n) & ~ri.exc;
        if ((saviors & ~placed) === 0n) return false;
      }
    }
    nodes++;
    const key = placed.toString(36) + '.' + stateSig();
    if (isRefuted(key, satisfied)) return false;
    // Candidate ordering heuristic (completeness preserved: all candidates are
    // still tried): first commits some unsatisfied read depends on, then
    // harmless ones, and defer commits that would overwrite a key an
    // unsatisfied read still needs to observe at a specific value.
    let needed = 0n;
    for (let r = 0; r < readInfo.length; r++) {
      if (!(satisfied & (1n << BigInt(r)))) needed |= readInfo[r].inc;
    }
    const candidates = [];
    for (let i = 0; i < n; i++) {
      if (isPlaced[i] || predCount[i] !== 0) continue;
      let score;
      if ((needed & (1n << BigInt(i))) !== 0n) {
        score = 0;
      } else {
        score = 1;
        outer: for (const op of commitOps[i]) {
          for (let r = 0; r < readInfo.length; r++) {
            const ri = readInfo[r];
            if (satisfied & (1n << BigInt(r))) continue;
            if ((ri.exc & (1n << BigInt(i))) !== 0n) continue;
            const want = ri.viewCanon.get(op.key);
            if (op.assert ? want !== op.canon : want !== undefined) {
              score = 2;
              break outer;
            }
          }
        }
      }
      candidates.push([score, i]);
    }
    candidates.sort((a, b) => a[0] - b[0]);
    for (const [, i] of candidates) {
      isPlaced[i] = 1;
      for (const j of commitSucc[i]) predCount[j]--;
      const count = applyCommit(i);
      order.push(commits[i].id);
      if (dfs(placed | (1n << BigInt(i)), satisfied)) return true;
      order.pop();
      undoCommit(count);
      for (const j of commitSucc[i]) predCount[j]++;
      isPlaced[i] = 0;
    }
    recordFailure(key, satisfied);
    return false;
  };

  if (dfs(0n, 0n)) return { linearizable: true, order: solution, stats: { nodes, memo: failed.size } };
  return {
    linearizable: false,
    code: 'E_NONLINEAR',
    reason: 'no serial order extending happens-before satisfies all reads',
  };
}
