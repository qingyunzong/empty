// Reference implementation: order-independent model of the revision engine.
//
// For a set of revisions (<= 6), every application permutation is enumerated;
// the final head set and winning version must be identical for all of them.
// This cross-checks the incremental head-tracking and merge rules used by
// the real engine.

function ancestorsOf(byHash, hash) {
  const seen = new Set();
  const stack = [...(byHash.get(hash)?.parents || [])];
  while (stack.length > 0) {
    const h = stack.pop();
    if (seen.has(h)) continue;
    seen.add(h);
    const r = byHash.get(h);
    if (r) stack.push(...r.parents);
  }
  return seen;
}

export class ReferenceState {
  constructor() {
    this.byHash = new Map();
    this.heads = new Set();
    this.pending = [];
  }

  apply(rev) {
    this.pending.push(rev);
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 0; i < this.pending.length; i++) {
        const r = this.pending[i];
        if (r.parents.every((p) => this.byHash.has(p))) {
          this.pending.splice(i, 1);
          this._add(r);
          progress = true;
          break;
        }
      }
    }
  }

  _add(rev) {
    this.byHash.set(rev.hash, rev);
    const anc = ancestorsOf(this.byHash, rev.hash);
    for (const h of [...this.heads]) {
      if (anc.has(h)) this.heads.delete(h);
    }
    let stale = false;
    for (const h of this.heads) {
      if (ancestorsOf(this.byHash, h).has(rev.hash)) {
        stale = true;
        break;
      }
    }
    if (!stale) this.heads.add(rev.hash);
  }

  // Deterministic winner derived from the current head set.
  winner() {
    const heads = [...this.heads].sort();
    if (heads.length === 0) return { status: 'EMPTY' };
    if (heads.length === 1) {
      return { status: this._isCancelled(heads[0]) ? 'CANCELLED' : 'OK', version: heads[0] };
    }
    const branches = heads.map((tip) => {
      const reach = new Set([tip, ...ancestorsOf(this.byHash, tip)]);
      const fields = new Set();
      let cancelled = false;
      for (const h of reach) {
        const dominated = heads.some((other) => {
          if (other === tip) return false;
          return other === h || ancestorsOf(this.byHash, other).has(h);
        });
        if (dominated) continue;
        const r = this.byHash.get(h);
        for (const f of Object.keys(r.patch || {})) fields.add(f);
        if (r.cancelled) cancelled = true;
      }
      return { tip, fields, cancelled };
    });
    const anyCancel = branches.some((b) => b.cancelled);
    const anyFieldMod = branches.some((b) => b.fields.size > 0);
    if (anyCancel && anyFieldMod) return { status: 'CANCELLED', heads };
    const seen = new Set();
    for (const b of branches) {
      for (const f of b.fields) {
        if (seen.has(f)) return { status: 'CONFLICT', heads };
        seen.add(f);
      }
    }
    return { status: anyCancel ? 'CANCELLED' : 'MERGED', heads };
  }

  _isCancelled(head) {
    // Replay the head's ancestor chain in topological (hash-ordered) passes.
    const chainSet = new Set([head, ...ancestorsOf(this.byHash, head)]);
    const chain = [...chainSet].map((h) => this.byHash.get(h));
    const done = new Set();
    let cancelled = false;
    let progress = true;
    while (progress) {
      progress = false;
      for (const r of chain) {
        if (done.has(r.hash)) continue;
        if (r.parents.every((p) => done.has(p) || !chainSet.has(p))) {
          if (r.cancelled) cancelled = true;
          done.add(r.hash);
          progress = true;
        }
      }
    }
    return cancelled;
  }
}

export function* permutations(items) {
  if (items.length <= 1) {
    yield items.slice();
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const perm of permutations(rest)) {
      yield [items[i], ...perm];
    }
  }
}

// Enumerate all application orders (n! for n <= 6) and verify that the final
// head set and winning version are identical for every permutation.
export function checkConvergence(revisions) {
  if (revisions.length > 6) {
    throw new RangeError(`reference check supports at most 6 revisions, got ${revisions.length}`);
  }
  let expected = null;
  let checked = 0;
  for (const perm of permutations(revisions)) {
    const state = new ReferenceState();
    for (const rev of perm) state.apply(rev);
    if (state.pending.length > 0) {
      return { ok: false, error: 'UNRESOLVED_PARENTS', pending: state.pending.map((r) => r.hash) };
    }
    const result = {
      heads: [...state.heads].sort(),
      winner: state.winner(),
    };
    const key = JSON.stringify(result);
    if (expected === null) expected = key;
    else if (key !== expected) {
      return { ok: false, divergent: { first: JSON.parse(expected), other: result }, permutations: checked + 1 };
    }
    checked++;
  }
  const final = expected ? JSON.parse(expected) : { heads: [], winner: { status: 'EMPTY' } };
  return { ok: true, permutations: checked, heads: final.heads, winner: final.winner };
}
