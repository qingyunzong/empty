import { Frac, ZERO, roundHalfEven } from './frac.js';
import { LedgerError } from './errors.js';

const STATE_OPS = new Set(['freeze', 'capture', 'void', 'reverse']);

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LedgerError('E_PARSE', `field "${field}" must be a non-empty string`);
  }
  return value;
}

function freshState() {
  return { frozen: new Map(), captures: [] };
}

function cloneState(s) {
  return {
    frozen: new Map([...s.frozen].map(([k, v]) => [k, new Frac(v.num, v.den)])),
    captures: s.captures.map((c) => ({ ...c, amount: new Frac(c.amount.num, c.amount.den) })),
  };
}

function frozenTotal(s) {
  let t = ZERO;
  for (const v of s.frozen.values()) t = t.add(v);
  return t;
}

function debtOf(s) {
  let d = ZERO;
  for (const c of s.captures) if (!c.reversed) d = d.add(c.amount);
  return d;
}

function availableOf(limit, s) {
  return limit.sub(frozenTotal(s)).sub(debtOf(s));
}

// Among reversible captures sharing the same id: smallest amount first,
// then lexicographic event id.
function selectCapture(s, captureId) {
  const cands = s.captures.filter((c) => !c.reversed && c.id === captureId);
  if (cands.length === 0) return null;
  cands.sort(
    (a, b) =>
      a.amount.cmp(b.amount) ||
      (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
  );
  return cands[0];
}

// Validate + apply one state op against `state`, mutating it.
// Throws LedgerError (E_PARSE / E_REF / E_STATE) on any violation.
function applyToState(limit, state, op, seq) {
  switch (op.type) {
    case 'freeze': {
      const tx = requireString(op.tx, 'tx');
      const amt = Frac.parse(op.amt);
      if (!amt.isPos()) throw new LedgerError('E_STATE', 'freeze amount must be positive');
      if (state.frozen.has(tx)) throw new LedgerError('E_REF', `duplicate freeze tx "${tx}"`);
      const avail = availableOf(limit, state);
      if (avail.cmp(amt) < 0) {
        throw new LedgerError('E_STATE', `insufficient available credit: have ${avail}, need ${amt}`, {
          available: avail.toString(),
          requested: amt.toString(),
        });
      }
      state.frozen.set(tx, amt);
      return;
    }
    case 'capture': {
      const tx = requireString(op.tx, 'tx');
      const remaining = state.frozen.get(tx);
      if (remaining === undefined || remaining.isZero()) {
        throw new LedgerError('E_REF', `no active freeze for tx "${tx}"`);
      }
      const amt = Frac.parse(op.amt);
      if (!amt.isPos()) throw new LedgerError('E_STATE', 'capture amount must be positive');
      // Freeze release is coupled with capture rounding: trial-round first with
      // ROUND_HALF_EVEN; if the rounded capture would make the freeze release
      // unrecoverable (negative remainder) or void, the whole op is E_STATE.
      const rounded = roundHalfEven(amt);
      if (!rounded.isPos()) {
        throw new LedgerError('E_STATE', `capture ${amt} rounds to zero under ROUND_HALF_EVEN`);
      }
      if (rounded.cmp(remaining) > 0) {
        throw new LedgerError(
          'E_STATE',
          `capture rounds to ${rounded} which exceeds frozen remainder ${remaining}; release would be unrecoverable`,
          { rounded: rounded.toString(), remainder: remaining.toString() },
        );
      }
      state.frozen.set(tx, remaining.sub(rounded));
      const id = op.id !== undefined ? requireString(op.id, 'id') : `cap#${seq}`;
      state.captures.push({ id, tx, amount: rounded, reversed: false, eventId: String(seq) });
      return;
    }
    case 'void': {
      const tx = requireString(op.tx, 'tx');
      const remaining = state.frozen.get(tx);
      if (remaining === undefined || remaining.isZero()) {
        throw new LedgerError('E_REF', `no active freeze for tx "${tx}"`);
      }
      state.frozen.set(tx, ZERO);
      return;
    }
    case 'reverse': {
      const captureId = requireString(op.captureId, 'captureId');
      const target = selectCapture(state, captureId);
      if (!target) throw new LedgerError('E_REF', `no reversible capture "${captureId}"`);
      target.reversed = true;
      return;
    }
    default:
      throw new LedgerError('E_PARSE', `unknown state op "${op.type}"`);
  }
}

export function snapshotOf(limit, st) {
  return {
    limit: limit.toString(),
    available: availableOf(limit, st).toString(),
    frozenTotal: frozenTotal(st).toString(),
    debt: debtOf(st).toString(),
    frozen: Object.fromEntries(
      [...st.frozen].filter(([, v]) => !v.isZero()).map(([k, v]) => [k, v.toString()]),
    ),
    captures: st.captures.map((c) => ({
      id: c.id,
      tx: c.tx,
      amount: c.amount.toString(),
      reversed: c.reversed,
      eventId: c.eventId,
    })),
  };
}

// Layered undo tree over an append-only event tree.
//
// - Every state op is a node; branches are (base, head) pointers into the tree.
// - merge{branch} copies the child's local ops onto the current branch, so a
//   child rollback (undo) can never undo already-merged ancestor events.
// - undo() moves the current branch head back one node but never past its base.
export class Ledger {
  constructor(limit) {
    this.limit = limit instanceof Frac ? limit : Frac.parse(limit);
    this.nodes = [{ seq: 0, op: { type: 'init' }, parent: -1, branch: 'main' }];
    this.branches = new Map([['main', { base: 0, head: 0 }]]);
    this.current = 'main';
  }

  _head() {
    return this.branches.get(this.current).head;
  }

  stateAt(seq) {
    const chain = [];
    for (let s = seq; s > 0; s = this.nodes[s].parent) chain.push(this.nodes[s]);
    const state = freshState();
    for (let i = chain.length - 1; i >= 0; i--) {
      applyToState(this.limit, state, chain[i].op, chain[i].seq);
    }
    return state;
  }

  state() {
    return this.stateAt(this._head());
  }

  snapshot() {
    const br = this.branches.get(this.current);
    return {
      ...snapshotOf(this.limit, this.stateAt(br.head)),
      branch: this.current,
      head: br.head,
      base: br.base,
    };
  }

  apply(op) {
    if (!op || typeof op !== 'object' || Array.isArray(op) || typeof op.type !== 'string') {
      throw new LedgerError('E_PARSE', 'event must be an object with a string "type"');
    }
    switch (op.type) {
      case 'freeze':
      case 'capture':
      case 'void':
      case 'reverse': {
        const seq = this.nodes.length;
        const stored = { ...op };
        if (op.type === 'capture' && stored.id === undefined) stored.id = `cap#${seq}`;
        const state = this.stateAt(this._head());
        applyToState(this.limit, state, stored, seq);
        this.nodes.push({ seq, op: stored, parent: this._head(), branch: this.current });
        this.branches.get(this.current).head = seq;
        return { seq, branch: this.current };
      }
      case 'branch': {
        const name = requireString(op.name, 'name');
        if (!Number.isInteger(op.fromEvent) || op.fromEvent < 0 || op.fromEvent >= this.nodes.length) {
          throw new LedgerError('E_REF', `unknown fromEvent ${op.fromEvent}`);
        }
        if (this.branches.has(name)) throw new LedgerError('E_REF', `branch "${name}" already exists`);
        this.branches.set(name, { base: op.fromEvent, head: op.fromEvent });
        this.current = name;
        return { branch: name, base: op.fromEvent };
      }
      case 'checkout': {
        const name = requireString(op.name, 'name');
        if (!this.branches.has(name)) throw new LedgerError('E_REF', `unknown branch "${name}"`);
        this.current = name;
        return { branch: name };
      }
      case 'merge':
        return this._merge(op);
      case 'undo': {
        const br = this.branches.get(this.current);
        if (br.head === br.base) {
          throw new LedgerError('E_STATE', `nothing to undo on branch "${this.current}"`);
        }
        br.head = this.nodes[br.head].parent;
        return { head: br.head };
      }
      default:
        throw new LedgerError('E_PARSE', `unknown event type "${op.type}"`);
    }
  }

  // Trial-apply the child's local ops onto current-branch state; on any
  // violation the whole merge fails with E_STATE plus a verifiable
  // counterexample. On success the ops are copied as new nodes.
  _merge(op) {
    const name = requireString(op.branch, 'branch');
    if (!this.branches.has(name)) throw new LedgerError('E_REF', `unknown branch "${name}"`);
    if (name === this.current) throw new LedgerError('E_REF', 'cannot merge a branch into itself');
    const child = this.branches.get(name);
    const chain = [];
    for (let s = child.head; s !== child.base; s = this.nodes[s].parent) chain.push(this.nodes[s]);
    chain.reverse();
    const ops = chain.map((n) => n.op).filter((o) => STATE_OPS.has(o.type));

    const trial = cloneState(this.stateAt(this._head()));
    for (let i = 0; i < ops.length; i++) {
      try {
        applyToState(this.limit, trial, ops[i], -1);
      } catch (e) {
        if (!(e instanceof LedgerError)) throw e;
        throw new LedgerError('E_STATE', `merge of branch "${name}" conflicts at op #${i}: ${e.message}`, {
          counterexample: {
            branch: name,
            index: i,
            failingOp: ops[i],
            code: e.code,
            reason: e.message,
            stateBefore: snapshotOf(this.limit, trial),
            remainingOps: ops.slice(i),
          },
        });
      }
    }

    const br = this.branches.get(this.current);
    for (const copied of ops) {
      const seq = this.nodes.length;
      this.nodes.push({ seq, op: copied, parent: br.head, branch: this.current, mergedFrom: name });
      br.head = seq;
    }
    return { merged: ops.length, from: name };
  }
}
