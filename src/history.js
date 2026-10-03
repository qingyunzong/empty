import { Store, hashRevision } from './store.js';
import { applyRevision, referenceCheck } from './reference.js';

export const MARGIN_RATE = 0.1;

const round = (x) => Math.round(x * 1e8) / 1e8;

export class HistError extends Error {
  constructor(code, message, exitCode = 1, extra = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.extra = extra;
  }
}

export class History {
  constructor(dir) {
    this.store = new Store(dir);
    this.reload();
  }

  reload() {
    const { records, error } = this.store.readAll();
    if (error) {
      throw new HistError('DATA_CORRUPT', `data file corrupt at offset ${error.offset}: ${error.message}`);
    }
    this.revs = new Map(records.map((r) => [r.rev.hash, r.rev]));
    this.memo = new Map();
  }

  tradeRevisions(tradeId) {
    return [...this.revs.values()].filter((r) => r.tradeId === tradeId);
  }

  heads(tradeId) {
    return this.store.getHeads(tradeId);
  }

  stateAt(hash) {
    if (this.memo.has(hash)) return this.memo.get(hash);
    const rev = this.revs.get(hash);
    if (!rev) throw new HistError('UNKNOWN_VERSION', `unknown revision ${hash}`);
    const state = applyRevision(rev, (h) => this.stateAt(h));
    this.memo.set(hash, state);
    return state;
  }

  nextSeq(author) {
    let max = 0;
    for (const r of this.revs.values()) if (r.author === author && r.seq > max) max = r.seq;
    return max + 1;
  }

  makeRev({ tradeId, op, parents, author, changes, winner = null }) {
    const rev = {
      tradeId,
      op,
      parents,
      author,
      seq: this.nextSeq(author),
      changes,
      winner,
      ts: Date.now(),
    };
    rev.hash = hashRevision(rev);
    return rev;
  }

  append(rev) {
    this.store.appendRecord(rev);
    this.revs.set(rev.hash, rev);
    return rev;
  }

  // Union of changes on the first-parent chain from head back to base
  // (exclusive of base). Values closer to head win.
  pathChanges(base, head) {
    const out = {};
    let cur = head;
    while (cur !== base) {
      const rev = this.revs.get(cur);
      if (!rev || rev.parents.length === 0) {
        throw new HistError('BASE_NOT_ANCESTOR', `base ${base} is not an ancestor of head ${head}`);
      }
      for (const [k, v] of Object.entries(rev.changes ?? {})) {
        if (!(k in out)) out[k] = v;
      }
      cur = rev.parents[0];
    }
    return out;
  }

  soleHead(tradeId) {
    const heads = this.heads(tradeId);
    if (heads.length === 0) throw new HistError('NOT_FOUND', `unknown trade ${tradeId}`);
    if (heads.length > 1) {
      throw new HistError('CONFLICT_UNRESOLVED', `trade ${tradeId} has concurrent heads; resolve first`, 2, {
        heads,
      });
    }
    return heads[0];
  }

  put({ tradeId, price, quantity, author }) {
    if (this.tradeRevisions(tradeId).length > 0) {
      throw new HistError('ALREADY_EXISTS', `trade ${tradeId} already exists`);
    }
    const rev = this.makeRev({
      tradeId,
      op: 'put',
      parents: [],
      author,
      changes: { price, quantity },
    });
    this.append(rev);
    return { status: 'ok', hash: rev.hash, revision: rev };
  }

  replace({ tradeId, base = null, price, quantity, author }) {
    const head = this.soleHead(tradeId);
    const headState = this.stateAt(head);
    if (headState.status === 'cancelled') {
      throw new HistError('CANCELLED', `trade ${tradeId} is cancelled; modifications rejected`);
    }
    base = base ?? head;
    const changes = {};
    if (price !== undefined) changes.price = price;
    if (quantity !== undefined) changes.quantity = quantity;
    if (Object.keys(changes).length === 0) {
      throw new HistError('NO_CHANGES', 'replace requires --price and/or --qty');
    }

    if (base === head) {
      const rev = this.makeRev({ tradeId, op: 'replace', parents: [head], author, changes });
      this.append(rev);
      return { status: 'ok', hash: rev.hash, revision: rev };
    }

    // Concurrent revision based on an older version.
    const theirs = this.pathChanges(base, head);
    if (theirs.status === 'cancelled') {
      throw new HistError('CANCELLED', `trade ${tradeId} was cancelled concurrently; cancel wins, modification rejected`);
    }
    const overlap = Object.keys(changes).filter((f) => f in theirs);
    const myRev = this.makeRev({ tradeId, op: 'replace', parents: [base], author, changes });

    if (overlap.length > 0) {
      // Same field modified on both sides: keep concurrent heads, require resolve.
      this.append(myRev);
      throw new HistError('CONFLICT', `conflicting fields: ${overlap.join(', ')}; concurrent heads kept`, 2, {
        heads: [head, myRev.hash].sort(),
        conflictingFields: overlap,
        revision: myRev.hash,
      });
    }

    // Disjoint fields: auto-merge.
    this.append(myRev);
    const merge = this.makeRev({
      tradeId,
      op: 'merge',
      parents: [head, myRev.hash],
      author,
      changes: { ...theirs, ...changes },
    });
    this.append(merge);
    return { status: 'merged', hash: merge.hash, base: myRev.hash, revision: merge };
  }

  cancel({ tradeId, base = null, author }) {
    const head = this.soleHead(tradeId);
    if (this.stateAt(head).status === 'cancelled') {
      throw new HistError('ALREADY_CANCELLED', `trade ${tradeId} is already cancelled`);
    }
    base = base ?? head;
    const changes = { status: 'cancelled' };

    if (base === head) {
      const rev = this.makeRev({ tradeId, op: 'cancel', parents: [head], author, changes });
      this.append(rev);
      return { status: 'ok', hash: rev.hash, revision: rev };
    }

    // Concurrent cancel: cancel always wins over field modifications.
    this.pathChanges(base, head); // validates ancestry
    const myRev = this.makeRev({ tradeId, op: 'cancel', parents: [base], author, changes });
    this.append(myRev);
    const merge = this.makeRev({
      tradeId,
      op: 'merge',
      parents: [head, myRev.hash],
      author,
      changes,
    });
    this.append(merge);
    return { status: 'merged', hash: merge.hash, base: myRev.hash, note: 'cancel_wins', revision: merge };
  }

  resolve({ tradeId, winner, price, quantity, author }) {
    const heads = this.heads(tradeId);
    if (heads.length < 2) {
      throw new HistError('NO_CONFLICT', `trade ${tradeId} has no conflict to resolve`);
    }
    if (!winner) throw new HistError('WINNER_REQUIRED', 'resolve requires --winner <hash>');
    if (!heads.includes(winner)) {
      throw new HistError('UNKNOWN_WINNER', `winner ${winner} is not one of the heads`, 1, { heads });
    }
    const changes = {};
    if (price !== undefined) changes.price = price;
    if (quantity !== undefined) changes.quantity = quantity;
    const rev = this.makeRev({
      tradeId,
      op: 'resolve',
      parents: [...heads].sort(),
      author,
      changes,
      winner,
    });
    this.append(rev);
    return { status: 'resolved', hash: rev.hash, revision: rev };
  }

  materialize(tradeId) {
    const heads = this.heads(tradeId);
    if (heads.length === 0) throw new HistError('NOT_FOUND', `unknown trade ${tradeId}`);
    const reference = referenceCheck(this.tradeRevisions(tradeId));
    if (heads.length > 1) {
      throw new HistError('CONFLICT', `trade ${tradeId} has ${heads.length} concurrent heads; resolve required`, 2, {
        heads: heads.map((h) => ({ hash: h, state: this.stateAt(h) })),
        reference,
      });
    }
    const state = this.stateAt(heads[0]);
    const notional = state.status === 'active' ? round(state.price * state.quantity) : 0;
    return {
      tradeId,
      head: heads[0],
      state,
      margin: { rate: MARGIN_RATE, notional, frozen: round(notional * MARGIN_RATE) },
      reference,
    };
  }

  history(tradeId) {
    const revs = this.tradeRevisions(tradeId);
    if (revs.length === 0) throw new HistError('NOT_FOUND', `unknown trade ${tradeId}`);
    const inSet = new Set(revs.map((r) => r.hash));
    const indegree = new Map(revs.map((r) => [r.hash, r.parents.filter((p) => inSet.has(p)).length]));
    const ready = revs.filter((r) => indegree.get(r.hash) === 0).map((r) => r.hash);
    const order = [];
    while (ready.length) {
      ready.sort((a, b) => {
        const ra = this.revs.get(a);
        const rb = this.revs.get(b);
        return ra.seq - rb.seq || a.localeCompare(b);
      });
      const hash = ready.shift();
      order.push(hash);
      for (const r of revs) {
        if (r.parents.includes(hash)) {
          indegree.set(r.hash, indegree.get(r.hash) - 1);
          if (indegree.get(r.hash) === 0) ready.push(r.hash);
        }
      }
    }
    return {
      tradeId,
      heads: this.heads(tradeId),
      revisions: order.map((h) => ({ ...this.revs.get(h), state: this.stateAt(h) })),
      reference: referenceCheck(revs),
    };
  }
}
