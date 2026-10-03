// Causal revision engine for transaction correction (replace) and cancellation.
//
// Semantics:
//  - put:      genesis revision of a transaction (price, qty).
//  - replace:  new revision patching price and/or qty, parented on a base
//              revision (default: current sole head). Old versions are kept.
//  - cancel:   cancellation revision.
//  - Two revisions built on the same parent never overwrite each other:
//      * disjoint modified fields  -> automatic merge revision (MERGED)
//      * cancel vs field modify    -> cancel wins, auto-merge to CANCELLED,
//                                     later modifications are rejected
//      * same field modified       -> parallel heads kept, CONFLICT returned;
//                                     successors are blocked until `resolve`
//  - resolve:  explicit revision with all conflicted heads as parents.
//  - materialize: replays the causal chain and recomputes the margin freeze.
import { createHash } from 'node:crypto';

export const MARGIN_RATE = 0.1;

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function hashRevision(rev) {
  const { hash, ...rest } = rev;
  return createHash('sha256').update(canonical(rest)).digest('hex');
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

export class Engine {
  constructor(store) {
    this.store = store;
  }

  _load() {
    const { records } = this.store.scan();
    const byHash = new Map();
    const byTx = new Map();
    for (const r of records) {
      byHash.set(r.hash, r);
      if (!byTx.has(r.txId)) byTx.set(r.txId, []);
      byTx.get(r.txId).push(r);
    }
    return { records, byHash, byTx };
  }

  _tips(txRevs) {
    const hasChild = new Set();
    for (const r of txRevs) for (const p of r.parents) hasChild.add(p);
    return txRevs.filter((r) => !hasChild.has(r.hash)).map((r) => r.hash);
  }

  // Proper ancestors of `hash` (excluding itself).
  _ancestors(byHash, hash) {
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

  _authorSeq(records, author) {
    let max = 0;
    for (const r of records) if (r.author === author && r.seq > max) max = r.seq;
    return max + 1;
  }

  // Replay a transaction's revisions in storage order (a valid causal order,
  // since parents are always appended before their children).
  _replay(txRevs) {
    const state = { price: null, qty: null, cancelled: false };
    for (const r of txRevs) {
      if (r.patch) {
        if (r.patch.price !== undefined) state.price = r.patch.price;
        if (r.patch.qty !== undefined) state.qty = r.patch.qty;
      }
      if (r.cancelled) state.cancelled = true;
    }
    return state;
  }

  _materializeTx(txRevs, tips) {
    if (tips.length > 1) {
      return { status: 'CONFLICT', heads: tips };
    }
    const state = this._replay(txRevs);
    const frozen = state.cancelled ? 0 : round2(state.price * state.qty * MARGIN_RATE);
    return {
      status: state.cancelled ? 'CANCELLED' : 'OK',
      price: state.price,
      qty: state.qty,
      cancelled: state.cancelled,
      frozen,
      marginRate: MARGIN_RATE,
      version: tips[0],
    };
  }

  // Exclusive ancestors of each tip: revisions reachable from that tip but
  // from no other tip. Used to attribute branch-local changes.
  _branchInfo(byHash, tips) {
    const reach = tips.map((t) => new Set([t, ...this._ancestors(byHash, t)]));
    return tips.map((tip, i) => {
      const others = new Set();
      reach.forEach((set, j) => {
        if (j !== i) for (const h of set) others.add(h);
      });
      const exclusive = [...reach[i]].filter((h) => !others.has(h));
      const fields = new Set();
      let cancelled = false;
      for (const h of exclusive) {
        const r = byHash.get(h);
        if (!r) continue;
        for (const f of Object.keys(r.patch || {})) fields.add(f);
        if (r.cancelled) cancelled = true;
      }
      return { tip, fields, cancelled };
    });
  }

  _append(record) {
    record.hash = hashRevision(record);
    this.store.append(record);
    return record;
  }

  _newRevision(txId, type, parents, author, records, patch, cancelled) {
    return {
      txId,
      type,
      parents,
      author,
      seq: this._authorSeq(records, author),
      patch: patch || {},
      cancelled: !!cancelled,
      ts: Date.now(),
    };
  }

  put({ txId, price, qty, author }) {
    const { records, byTx } = this._load();
    if (byTx.has(txId)) return { ok: false, error: 'TX_EXISTS', txId };
    const rev = this._newRevision(txId, 'put', [], author, records, { price, qty }, false);
    this._append(rev);
    return { ok: true, status: 'OK', txId, head: rev.hash, revision: rev };
  }

  // Shared path for replace/cancel. `change` = { patch, cancelled, type }.
  _change({ txId, base, author, change }) {
    const { records, byHash, byTx } = this._load();
    const txRevs = byTx.get(txId);
    if (!txRevs) return { ok: false, error: 'TX_NOT_FOUND', txId };
    const tips = this._tips(txRevs);
    if (tips.length > 1) {
      return { ok: false, status: 'UNRESOLVED_CONFLICT', error: 'UNRESOLVED_CONFLICT', heads: tips };
    }
    const current = this._materializeTx(txRevs, tips);
    if (current.cancelled) return { ok: false, error: 'TX_CANCELLED', txId };

    const parent = base || tips[0];
    if (!byHash.has(parent) || !txRevs.some((r) => r.hash === parent)) {
      return { ok: false, error: 'BASE_NOT_FOUND', base: parent };
    }
    const rev = this._newRevision(txId, change.type, [parent], author, records, change.patch, change.cancelled);
    this._append(rev);

    const txRevs2 = [...txRevs, rev];
    const byHash2 = new Map(byHash);
    byHash2.set(rev.hash, rev);
    const tips2 = this._tips(txRevs2);
    if (tips2.length === 1) {
      return { ok: true, status: 'OK', txId, head: rev.hash, revision: rev };
    }

    // Concurrent heads: decide auto-merge vs conflict.
    const branches = this._branchInfo(byHash2, tips2);
    const anyCancel = branches.some((b) => b.cancelled);
    const anyFieldMod = branches.some((b) => b.fields.size > 0);
    if (anyCancel && anyFieldMod) {
      // Cancel takes precedence over concurrent field modifications.
      const merge = this._newRevision(txId, 'merge', tips2, author, [...records, rev], {}, true);
      this._append(merge);
      return { ok: true, status: 'MERGED_CANCEL', txId, head: merge.hash, mergedHeads: tips2, revision: rev };
    }
    const seen = new Map();
    const overlapping = new Set();
    for (const b of branches) {
      for (const f of b.fields) {
        if (seen.has(f) && seen.get(f) !== b.tip) overlapping.add(f);
        seen.set(f, b.tip);
      }
    }
    if (overlapping.size === 0) {
      // Disjoint fields: automatic merge. Each field takes the final value
      // of the (single) branch that touched it, obtained by replaying that
      // branch tip's ancestor chain in storage order.
      const patch = {};
      let cancelled = false;
      for (const b of branches) {
        if (b.fields.size === 0 && !b.cancelled) continue;
        const chainSet = new Set([b.tip, ...this._ancestors(byHash2, b.tip)]);
        const chain = txRevs2.filter((r) => chainSet.has(r.hash));
        const st = this._replay(chain);
        for (const f of b.fields) patch[f] = st[f];
        if (b.cancelled) cancelled = true;
      }
      const merge = this._newRevision(txId, 'merge', tips2, author, [...records, rev], patch, cancelled);
      this._append(merge);
      return { ok: true, status: 'MERGED', txId, head: merge.hash, mergedHeads: tips2, patch, revision: rev };
    }
    // Same field modified on both sides: keep parallel heads.
    return {
      ok: false,
      status: 'CONFLICT',
      txId,
      heads: tips2,
      fields: [...overlapping],
      revision: rev,
    };
  }

  replace({ txId, base, price, qty, author }) {
    const patch = {};
    if (price !== undefined) patch.price = price;
    if (qty !== undefined) patch.qty = qty;
    if (Object.keys(patch).length === 0) return { ok: false, error: 'EMPTY_PATCH' };
    return this._change({ txId, base, author, change: { type: 'replace', patch, cancelled: false } });
  }

  cancel({ txId, base, author }) {
    return this._change({ txId, base, author, change: { type: 'cancel', patch: {}, cancelled: true } });
  }

  resolve({ txId, author, price, qty, cancel }) {
    const { records, byTx } = this._load();
    const txRevs = byTx.get(txId);
    if (!txRevs) return { ok: false, error: 'TX_NOT_FOUND', txId };
    const tips = this._tips(txRevs);
    if (tips.length <= 1) return { ok: false, error: 'NO_CONFLICT', txId };
    const patch = {};
    if (price !== undefined) patch.price = price;
    if (qty !== undefined) patch.qty = qty;
    if (Object.keys(patch).length === 0 && !cancel) {
      return { ok: false, error: 'EMPTY_RESOLUTION', heads: tips };
    }
    const rev = this._newRevision(txId, 'resolve', tips, author, records, patch, !!cancel);
    this._append(rev);
    return { ok: true, status: 'RESOLVED', txId, head: rev.hash, resolvedHeads: tips, revision: rev };
  }

  materialize({ txId }) {
    const { byTx } = this._load();
    const txRevs = byTx.get(txId);
    if (!txRevs) return { ok: false, error: 'TX_NOT_FOUND', txId };
    const tips = this._tips(txRevs);
    const m = this._materializeTx(txRevs, tips);
    if (m.status === 'CONFLICT') {
      return { ok: false, status: 'CONFLICT', error: 'UNRESOLVED_CONFLICT', txId, heads: m.heads };
    }
    return { ok: true, txId, revisions: txRevs.length, heads: tips, ...m };
  }

  history({ txId } = {}) {
    const { records, byTx } = this._load();
    const list = txId ? byTx.get(txId) || [] : records;
    const tips = txId && list.length > 0 ? this._tips(list) : null;
    return {
      ok: true,
      ...(txId ? { txId, heads: tips } : {}),
      revisions: list.map((r) => ({
        hash: r.hash,
        txId: r.txId,
        type: r.type,
        parents: r.parents,
        author: r.author,
        seq: r.seq,
        patch: r.patch,
        cancelled: r.cancelled,
        loc: r._loc,
      })),
    };
  }
}
