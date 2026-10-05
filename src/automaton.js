// Automaton model of the balance semantics.
//
// A ledger is a stream of events. Events of the same account form a causal
// chain and must be consumed in stream order; events of different accounts
// may be interleaved arbitrarily. A LedgerAutomaton accepts exactly the
// locally balanced sequences: every consumed prefix respects per-account
// causality, and a fully consumed sequence is accepting iff every
// (relId, currency) group nets to zero (debits pair with credits), which
// also implies per-currency totals of zero.

export const SCALE = 1_000_000;

export function toMinor(amount) {
  return Math.round(amount * SCALE);
}

export function signedMinor(event) {
  return (event.direction === 'debit' ? 1 : -1) * toMinor(event.amount);
}

export function canonicalForm(event) {
  return [event.account, String(event.amount), event.direction, event.currency, event.relId].join('|');
}

export function groupNets(events) {
  const groups = new Map();
  for (const e of events) {
    const key = `${e.relId} ${e.currency}`;
    let g = groups.get(key);
    if (!g) {
      g = { relId: e.relId, currency: e.currency, net: 0, events: [] };
      groups.set(key, g);
    }
    g.net += signedMinor(e);
    g.events.push(e);
  }
  return groups;
}

export function unbalancedGroups(events) {
  return [...groupNets(events).values()].filter((g) => g.net !== 0);
}

export function internallyBalanced(events) {
  for (const g of groupNets(events).values()) {
    if (g.net !== 0) return false;
  }
  return true;
}

export class LedgerAutomaton {
  constructor(events) {
    this.events = events;
    const byAccount = new Map();
    events.forEach((e, i) => {
      if (!byAccount.has(e.account)) byAccount.set(e.account, []);
      byAccount.get(e.account).push(i);
    });
    this.chains = [...byAccount.values()];
    this.chainOf = new Array(events.length);
    this.chains.forEach((chain, ci) => {
      for (const idx of chain) this.chainOf[idx] = ci;
    });
  }

  initialState() {
    return { pos: new Array(this.chains.length).fill(0), nets: new Map() };
  }

  frontier(state) {
    const out = [];
    this.chains.forEach((chain, ci) => {
      if (state.pos[ci] < chain.length) out.push(chain[state.pos[ci]]);
    });
    return out;
  }

  consume(state, eventIndex) {
    const ci = this.chainOf[eventIndex];
    if (this.chains[ci][state.pos[ci]] !== eventIndex) {
      throw new Error(`causal order violated: event #${eventIndex} is not at its account frontier`);
    }
    const e = this.events[eventIndex];
    const pos = state.pos.slice();
    pos[ci] += 1;
    const nets = new Map(state.nets);
    const key = `${e.relId} ${e.currency}`;
    nets.set(key, (nets.get(key) || 0) + signedMinor(e));
    return { pos, nets };
  }

  consumed(state) {
    return state.pos.every((p, ci) => p === this.chains[ci].length);
  }

  isAccepting(state) {
    if (!this.consumed(state)) return false;
    for (const v of state.nets.values()) {
      if (v !== 0) return false;
    }
    return true;
  }

  stateKey(state) {
    const nets = [...state.nets.entries()]
      .filter(([, v]) => v !== 0)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return `${state.pos.join('.')}|${nets}`;
  }
}

// Product automaton over a pair of ledgers. A joint step consumes one event
// from either side; the exposure multiset records canonical forms consumed
// from the left but not yet matched by the right (negative counts for the
// opposite direction). A joint state is accepting iff both components are
// accepting and the exposure is empty, i.e. the two ledgers carry identical
// multisets of canonical events and are each internally balanced.
export class ProductAutomaton {
  constructor(leftEvents, rightEvents) {
    this.left = new LedgerAutomaton(leftEvents);
    this.right = new LedgerAutomaton(rightEvents);
  }

  initialState() {
    return { l: this.left.initialState(), r: this.right.initialState(), exposure: new Map() };
  }

  static bump(exposure, form, delta) {
    const next = (exposure.get(form) || 0) + delta;
    if (next === 0) exposure.delete(form);
    else exposure.set(form, next);
  }

  transitions(state) {
    const out = [];
    for (const idx of this.left.frontier(state.l)) {
      const e = this.left.events[idx];
      const exposure = new Map(state.exposure);
      ProductAutomaton.bump(exposure, canonicalForm(e), 1);
      out.push({ side: 'left', event: e, state: { l: this.left.consume(state.l, idx), r: state.r, exposure } });
    }
    for (const idx of this.right.frontier(state.r)) {
      const e = this.right.events[idx];
      const exposure = new Map(state.exposure);
      ProductAutomaton.bump(exposure, canonicalForm(e), -1);
      out.push({ side: 'right', event: e, state: { l: state.l, r: this.right.consume(state.r, idx), exposure } });
    }
    return out;
  }

  isAccepting(state) {
    return this.left.isAccepting(state.l) && this.right.isAccepting(state.r) && state.exposure.size === 0;
  }

  stateKey(state) {
    const exposure = [...state.exposure.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return `${this.left.stateKey(state.l)}#${this.right.stateKey(state.r)}#${exposure}`;
  }

  // Breadth-first search for an accepting joint run. Returns
  // { path } on success, null when no accepting run exists, or 'BOUND' when
  // the state budget was exhausted (which must never be read as "no diff").
  findAcceptingPath(budget = 200_000) {
    const start = this.initialState();
    if (this.isAccepting(start)) return { path: [], explored: 1 };
    const seen = new Set([this.stateKey(start)]);
    let level = [{ state: start, path: [] }];
    let explored = 1;
    while (level.length > 0) {
      const next = [];
      for (const node of level) {
        for (const t of this.transitions(node.state)) {
          const key = this.stateKey(t.state);
          if (seen.has(key)) continue;
          seen.add(key);
          explored += 1;
          if (explored > budget) return 'BOUND';
          const path = node.path.concat([{ side: t.side, id: t.event.id }]);
          if (this.isAccepting(t.state)) return { path, explored };
          next.push({ state: t.state, path });
        }
      }
      level = next;
    }
    return null;
  }
}
