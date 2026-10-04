// Event-sourced credit-hold ledger.
//
// Domain: authorize (freeze) -> release (partial unfreeze) / reverse (void) /
// capture (settlement debit). Split/merge rewire the authorization topology.
// Derived state (account held/available, merchant settled) lives in a DepGraph:
// mutations invalidate source nodes and propagation refreshes dependents
// differentially. Every applied command appends a change record to the journal
// explaining the source of each balance movement; replay(journal, k) rebuilds
// the exact state after any prefix k deterministically.

import { DepGraph } from './graph.js';

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

const OPS = new Set(['open_account', 'authorize', 'release', 'reverse', 'capture', 'split', 'merge']);

function isAmount(n) {
  return Number.isInteger(n) && n > 0;
}

export class Ledger {
  constructor() {
    this.accounts = new Map(); // id -> { id, limit, posted, holds:Map<authId,Hold>, closed:[] }
    this.merchants = new Map(); // id -> settled total
    this.graph = new DepGraph();
    this.journal = []; // applied change records
    this.clock = 0; // arrival sequence
  }

  // ---- derived-state wiring -------------------------------------------------

  #wireAccount(accountId) {
    this.graph.addNode(`held:${accountId}`, () => {
      const acct = this.accounts.get(accountId);
      let sum = 0;
      for (const hold of acct.holds.values()) sum += hold.held;
      return sum;
    });
    this.graph.addNode(
      `available:${accountId}`,
      (get) => {
        const acct = this.accounts.get(accountId);
        return acct.limit - acct.posted - get(`held:${accountId}`);
      },
      [`held:${accountId}`],
    );
  }

  #wireAuth(accountId, authId) {
    this.graph.addNode(`authHeld:${accountId}/${authId}`, () => {
      const hold = this.accounts.get(accountId).holds.get(authId);
      return hold ? hold.held : 0;
    });
  }

  #wireMerchant(merchantId) {
    if (!this.graph.nodes.has(`settled:${merchantId}`)) {
      this.graph.addNode(`settled:${merchantId}`, () => this.merchants.get(merchantId) ?? 0);
    }
  }

  // ---- queries ----------------------------------------------------------------

  available(accountId) {
    return this.graph.get(`available:${accountId}`);
  }

  held(accountId) {
    return this.graph.get(`held:${accountId}`);
  }

  settled(merchantId) {
    this.#wireMerchant(merchantId);
    return this.graph.get(`settled:${merchantId}`);
  }

  snapshot() {
    return {
      accounts: [...this.accounts.values()].map((a) => ({
        accountId: a.id,
        creditLimit: a.limit,
        held: this.held(a.id),
        posted: a.posted,
        available: this.available(a.id),
        openAuthorizations: [...a.holds.values()].map((h) => ({
          authId: h.authId,
          authorized: h.authorized,
          held: h.held,
          captured: h.captured,
          released: h.released,
          parent: h.parent,
        })),
      })),
      merchants: [...this.merchants.entries()].map(([merchantId, settled]) => ({ merchantId, settled })),
      eventsApplied: this.journal.length,
    };
  }

  // ---- command application ----------------------------------------------------

  #getAccount(id) {
    const acct = this.accounts.get(id);
    if (!acct) throw new LedgerError('UNKNOWN_ACCOUNT', `account not found: ${id}`);
    return acct;
  }

  #getOpenHold(acct, authId) {
    const hold = acct.holds.get(authId);
    if (!hold) {
      const closed = acct.closed.find((h) => h.authId === authId);
      if (closed) throw new LedgerError('AUTH_CLOSED', `authorization already closed: ${authId}`);
      throw new LedgerError('UNKNOWN_AUTH', `authorization not found: ${authId}`);
    }
    return hold;
  }

  #record(cmd, deltas, reason, extra = {}) {
    const rec = {
      seq: this.clock,
      op: cmd.op,
      requestId: cmd.requestId ?? null,
      accountId: cmd.accountId ?? null,
      deltas,
      reason,
      ...extra,
    };
    this.journal.push(rec);
    return rec;
  }

  apply(cmd) {
    if (!cmd || !OPS.has(cmd.op)) {
      throw new LedgerError('VALIDATION', `unknown or missing op: ${cmd && cmd.op}`);
    }
    const arrival = this.clock;
    const rec = this.#dispatch(cmd);
    this.clock = arrival + 1;
    return rec;
  }

  // Concurrent captures on the same authorization are totally ordered by
  // arrival seq, ties broken by requestId. Other commands keep arrival order.
  applyBatch(cmds) {
    const groups = new Map(); // account/auth key -> captures
    const order = [];
    for (const cmd of cmds) {
      if (cmd.op === 'capture') {
        const key = `${cmd.accountId}/${cmd.authId}`;
        if (!groups.has(key)) {
          groups.set(key, []);
          order.push(key);
        }
        groups.get(key).push(cmd);
      } else {
        order.push(cmd);
      }
    }
    const results = [];
    for (const item of order) {
      if (typeof item === 'string') {
        const caps = groups.get(item).sort(
          (a, b) => (a.seq ?? 0) - (b.seq ?? 0) || String(a.requestId).localeCompare(String(b.requestId)),
        );
        for (const c of caps) results.push(this.apply(c));
      } else {
        results.push(this.apply(item));
      }
    }
    return results;
  }

  #dispatch(cmd) {
    switch (cmd.op) {
      case 'open_account': return this.#openAccount(cmd);
      case 'authorize': return this.#authorize(cmd);
      case 'release': return this.#release(cmd);
      case 'reverse': return this.#reverse(cmd);
      case 'capture': return this.#capture(cmd);
      case 'split': return this.#split(cmd);
      case 'merge': return this.#merge(cmd);
      default: throw new LedgerError('VALIDATION', `unhandled op: ${cmd.op}`);
    }
  }

  #openAccount(cmd) {
    const { accountId, creditLimit } = cmd;
    if (!accountId || !Number.isInteger(creditLimit) || creditLimit < 0) {
      throw new LedgerError('VALIDATION', 'open_account requires accountId and integer creditLimit >= 0');
    }
    if (this.accounts.has(accountId)) {
      throw new LedgerError('DUPLICATE_ACCOUNT', `account already exists: ${accountId}`);
    }
    this.accounts.set(accountId, { id: accountId, limit: creditLimit, posted: 0, holds: new Map(), closed: [] });
    this.#wireAccount(accountId);
    return this.#record(cmd, { held: 0, available: creditLimit, posted: 0 },
      `open account ${accountId} with credit limit ${creditLimit}`);
  }

  #authorize(cmd) {
    const { accountId, authId, amount } = cmd;
    const acct = this.#getAccount(accountId);
    if (!authId || !isAmount(amount)) {
      throw new LedgerError('VALIDATION', 'authorize requires authId and positive integer amount');
    }
    if (acct.holds.has(authId)) {
      throw new LedgerError('DUPLICATE_AUTH', `authorization already open: ${authId}`);
    }
    // Validate before any mutation: no partial state on INSUFFICIENT.
    const avail = this.available(accountId);
    if (amount > avail) {
      throw new LedgerError('INSUFFICIENT',
        `authorize ${amount} exceeds available ${avail} on ${accountId}`);
    }
    const hold = {
      authId, accountId, authorized: amount, held: amount, captured: 0, released: 0,
      status: 'open', parent: cmd.parent ?? null, captures: [],
    };
    acct.holds.set(authId, hold);
    this.#wireAuth(accountId, authId);
    this.graph.invalidate(`held:${accountId}`);
    return this.#record(cmd, { held: +amount, available: -amount, posted: 0 },
      `authorize ${authId}: freeze ${amount} (available ${avail} -> ${avail - amount})`,
      { authId, amount });
  }

  #release(cmd) {
    const { accountId, authId, amount } = cmd;
    const acct = this.#getAccount(accountId);
    const hold = this.#getOpenHold(acct, authId);
    if (!isAmount(amount)) throw new LedgerError('VALIDATION', 'release requires positive integer amount');
    if (amount > hold.held) {
      throw new LedgerError('EXCEEDS_HELD',
        `release ${amount} exceeds remaining frozen ${hold.held} on ${authId}`);
    }
    hold.held -= amount;
    hold.released += amount;
    this.graph.invalidate(`held:${accountId}`);
    return this.#record(cmd, { held: -amount, available: +amount, posted: 0 },
      `release ${amount} on ${authId}: unfreeze (remaining frozen ${hold.held})`,
      { authId, amount });
  }

  #reverse(cmd) {
    const { accountId, authId } = cmd;
    const acct = this.#getAccount(accountId);
    const hold = this.#getOpenHold(acct, authId);
    const freed = hold.held;
    hold.held = 0;
    hold.released += freed;
    hold.status = 'reversed';
    acct.holds.delete(authId);
    acct.closed.push(hold);
    // Invalidation propagates: authHeld -> held -> available. The authId is
    // now reusable; a later authorize rewires a fresh node for it.
    this.graph.invalidate(`authHeld:${accountId}/${authId}`);
    this.graph.invalidate(`held:${accountId}`);
    return this.#record(cmd, { held: -freed, available: +freed, posted: 0 },
      `reverse ${authId}: void remaining frozen ${freed} (captured ${hold.captured} stays settled)`,
      { authId, amount: freed });
  }

  #capture(cmd) {
    const { accountId, authId, amount, merchantId = 'default' } = cmd;
    const acct = this.#getAccount(accountId);
    const hold = this.#getOpenHold(acct, authId);
    if (!isAmount(amount)) throw new LedgerError('VALIDATION', 'capture requires positive integer amount');
    if (amount > hold.held) {
      throw new LedgerError('EXCEEDS_HELD',
        `capture ${amount} exceeds remaining frozen ${hold.held} on ${authId}`);
    }
    hold.held -= amount;
    hold.captured += amount;
    hold.captures.push({ amount, merchantId, requestId: cmd.requestId ?? null, seq: cmd.seq ?? null });
    acct.posted += amount;
    this.merchants.set(merchantId, (this.merchants.get(merchantId) ?? 0) + amount);
    this.#wireMerchant(merchantId);
    this.graph.invalidate(`held:${accountId}`);
    this.graph.invalidate(`settled:${merchantId}`);
    return this.#record(cmd, { held: -amount, available: 0, posted: +amount },
      `capture ${amount} on ${authId} for merchant ${merchantId}: frozen -> posted (remaining frozen ${hold.held})`,
      { authId, amount, merchantId });
  }

  #split(cmd) {
    const { accountId, authId, into } = cmd;
    const acct = this.#getAccount(accountId);
    const hold = this.#getOpenHold(acct, authId);
    if (!Array.isArray(into) || into.length < 2) {
      throw new LedgerError('VALIDATION', 'split requires into: [{authId, amount}, ...] (>= 2)');
    }
    let sum = 0;
    for (const part of into) {
      if (!part.authId || !isAmount(part.amount)) {
        throw new LedgerError('VALIDATION', 'split parts require authId and positive integer amount');
      }
      if (acct.holds.has(part.authId)) {
        throw new LedgerError('DUPLICATE_AUTH', `split target already open: ${part.authId}`);
      }
      sum += part.amount;
    }
    if (sum !== hold.held) {
      throw new LedgerError('EXCEEDS_HELD',
        `split parts sum ${sum} != remaining frozen ${hold.held} on ${authId}`);
    }
    hold.status = 'split';
    const freed = hold.held;
    hold.held = 0;
    acct.holds.delete(authId);
    acct.closed.push(hold);
    this.graph.invalidate(`authHeld:${accountId}/${authId}`);
    for (const part of into) {
      acct.holds.set(part.authId, {
        authId: part.authId, accountId, authorized: part.amount, held: part.amount,
        captured: 0, released: 0, status: 'open', parent: authId, captures: [],
      });
      this.#wireAuth(accountId, part.authId);
    }
    this.graph.invalidate(`held:${accountId}`);
    return this.#record(cmd, { held: 0, available: 0, posted: 0 },
      `split ${authId} (frozen ${freed}) into ${into.map((p) => `${p.authId}:${p.amount}`).join(', ')}`,
      { authId, amount: freed, children: into.map((p) => p.authId) });
  }

  #merge(cmd) {
    const { accountId, from, into } = cmd;
    const acct = this.#getAccount(accountId);
    if (!Array.isArray(from) || from.length < 2 || !into) {
      throw new LedgerError('VALIDATION', 'merge requires from: [authId, ...] (>= 2) and into: authId');
    }
    if (acct.holds.has(into)) throw new LedgerError('DUPLICATE_AUTH', `merge target already open: ${into}`);
    const sources = from.map((id) => this.#getOpenHold(acct, id));
    let total = 0;
    for (const s of sources) total += s.held;
    for (const s of sources) {
      s.status = 'merged';
      s.held = 0;
      acct.holds.delete(s.authId);
      acct.closed.push(s);
      this.graph.invalidate(`authHeld:${accountId}/${s.authId}`);
    }
    acct.holds.set(into, {
      authId: into, accountId, authorized: total, held: total,
      captured: 0, released: 0, status: 'open', parent: null, captures: [],
      mergedFrom: [...from],
    });
    this.#wireAuth(accountId, into);
    this.graph.invalidate(`held:${accountId}`);
    return this.#record(cmd, { held: 0, available: 0, posted: 0 },
      `merge ${from.join(', ')} into ${into}: combined frozen ${total}`,
      { authId: into, amount: total });
  }

  // ---- deterministic replay -----------------------------------------------------

  static replay(events, prefix) {
    const ledger = new Ledger();
    const n = prefix === undefined ? events.length : Math.min(prefix, events.length);
    for (let i = 0; i < n; i++) ledger.apply(events[i]);
    return ledger;
  }
}
