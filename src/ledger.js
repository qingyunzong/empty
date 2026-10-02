import { SCALE, LedgerError, canonical, sha256, parseDecimal, formatDecimal } from './util.js';
import { merkleRoot, merkleProof } from './merkle.js';

export const GENESIS = sha256('genesis');

function normalizePostings(postings) {
  if (!Array.isArray(postings) || postings.length === 0) {
    throw new LedgerError('INVALID_OP', 'voucher requires a non-empty postings array');
  }
  const normalized = postings.map((p) => {
    if (!p || typeof p.account !== 'string' || p.account.length === 0) {
      throw new LedgerError('INVALID_OP', 'posting requires a non-empty account');
    }
    if (typeof p.currency !== 'string' || p.currency.length === 0) {
      throw new LedgerError('INVALID_OP', 'posting requires a non-empty currency');
    }
    return { account: p.account, currency: p.currency, amount: parseDecimal(p.amount) };
  });
  normalized.sort((a, b) =>
    a.account < b.account ? -1
      : a.account > b.account ? 1
        : a.currency < b.currency ? -1
          : a.currency > b.currency ? 1 : 0);
  return normalized;
}

function voucherHash(rec) {
  return sha256('voucher', canonical({
    id: rec.id,
    lamport: rec.lamport,
    snapshot: rec.snapshot,
    reverses: rec.reverses,
    postings: rec.postings.map((p) => ({
      account: p.account,
      currency: p.currency,
      amount: p.amount.toString(),
    })),
  }));
}

export class Ledger {
  constructor({ base = 'BASE' } = {}) {
    this.base = base;
    this.clock = 0;
    this.snapshots = new Map(); // id -> { currency: scaledRate }
    this.vouchers = new Map(); // id -> voucher record
    this.order = []; // voucher ids in canonical order (lamport, id)
    this.pending = new Map(); // voucher id -> record awaiting its snapshot
    this.pendingReversals = []; // [{ id, target, lamport }] awaiting their target
    this.reversed = new Set();
    this.invalidated = new Set();
    this.chainLinks = []; // chainLinks[i] corresponds to order[i]
    this.prefixBalances = [{}]; // prefixBalances[i]: balances after order[0..i-1]
  }

  addSnapshot(id, rates) {
    if (typeof id !== 'string' || !id) throw new LedgerError('INVALID_OP', 'snapshot id required');
    if (this.snapshots.has(id)) {
      throw new LedgerError('DUPLICATE_ID', `snapshot ${id} already registered`);
    }
    if (rates === null || typeof rates !== 'object') {
      throw new LedgerError('INVALID_OP', 'snapshot rates must be an object');
    }
    const scaled = {};
    for (const [currency, rate] of Object.entries(rates)) {
      scaled[currency] = parseDecimal(rate, 'INVALID_RATE');
    }
    this.snapshots.set(id, scaled);
    const applied = [];
    const invalidated = [];
    for (const [vid, rec] of [...this.pending]) {
      if (rec.snapshot === id) {
        this.pending.delete(vid);
        invalidated.push(...this.#insert(rec));
        applied.push(vid);
      }
    }
    return { applied: applied.sort(), invalidated: [...new Set(invalidated)].sort() };
  }

  addVoucher(input) {
    return this.#accept(this.#normalizeVoucher(input));
  }

  reverse({ id, target, lamport = null }) {
    if (typeof id !== 'string' || !id) throw new LedgerError('INVALID_OP', 'reversal id required');
    if (this.vouchers.has(id) || this.pending.has(id)
      || this.pendingReversals.some((r) => r.id === id)) {
      throw new LedgerError('DUPLICATE_ID', `voucher ${id} already exists`);
    }
    if (this.reversed.has(target)
      || this.pendingReversals.some((r) => r.target === target)) {
      throw new LedgerError('ALREADY_REVERSED', `voucher ${target} already reversed`);
    }
    if (!this.vouchers.has(target)) {
      // Target may simply not have arrived yet: queue instead of failing.
      this.pendingReversals.push({ id, target, lamport });
      return { pending: true, id, invalidated: [] };
    }
    return this.#applyReversal({ id, target, lamport });
  }

  finalize() {
    if (this.pending.size > 0) {
      const missing = [...this.pending.values()].map((r) => `${r.id}<-${r.snapshot}`);
      throw new LedgerError('MISSING_SNAPSHOT', `unresolved snapshot dependencies: ${missing.join(', ')}`);
    }
    if (this.pendingReversals.length > 0) {
      const targets = this.pendingReversals.map((r) => r.target);
      throw new LedgerError('UNKNOWN_TARGET', `reversal targets not found: ${targets.join(', ')}`);
    }
    return { root: this.root() };
  }

  root() {
    const leaves = this.order.map((id) => this.vouchers.get(id).hash);
    const tip = this.chainLinks.length ? this.chainLinks[this.chainLinks.length - 1] : GENESIS;
    return sha256(
      'root',
      merkleRoot(leaves),
      tip,
      this.#balancesHash(),
      canonical([...this.invalidated].sort()),
      canonical([...this.reversed].sort()),
    );
  }

  proof(id) {
    const index = this.order.indexOf(id);
    if (index < 0) throw new LedgerError('UNKNOWN_TARGET', `voucher ${id} not found`);
    const leaves = this.order.map((vid) => this.vouchers.get(vid).hash);
    return {
      id,
      index,
      leaf: leaves[index],
      merkleRoot: merkleRoot(leaves),
      path: merkleProof(leaves, index),
    };
  }

  balances() {
    const out = {};
    for (const [account, value] of Object.entries(this.prefixBalances[this.order.length])) {
      out[account] = formatDecimal(value);
    }
    return out;
  }

  verifyChain() {
    let prev = GENESIS;
    for (let i = 0; i < this.order.length; i++) {
      const expected = sha256('chain', prev, this.vouchers.get(this.order[i]).hash);
      if (this.chainLinks[i] !== expected) return i;
      prev = expected;
    }
    return -1;
  }

  recover() {
    const brokenAt = this.verifyChain();
    this.#recomputeFrom(0);
    return { brokenAt, root: this.root() };
  }

  fullRecompute() {
    this.#recomputeFrom(0);
    return this.root();
  }

  serialize() {
    const snapshots = {};
    for (const [id, rates] of [...this.snapshots.entries()].sort()) {
      snapshots[id] = {};
      for (const [currency, rate] of Object.entries(rates).sort()) {
        snapshots[id][currency] = formatDecimal(rate);
      }
    }
    return {
      base: this.base,
      snapshots,
      vouchers: this.order.map((id) => {
        const rec = this.vouchers.get(id);
        return {
          id: rec.id,
          lamport: rec.lamport,
          snapshot: rec.snapshot,
          reverses: rec.reverses,
          postings: rec.postings.map((p) => ({
            account: p.account,
            currency: p.currency,
            amount: formatDecimal(p.amount),
          })),
          hash: rec.hash,
        };
      }),
      reversed: [...this.reversed].sort(),
      invalidated: [...this.invalidated].sort(),
      balances: this.balances(),
      chainTip: this.chainLinks.length ? this.chainLinks[this.chainLinks.length - 1] : GENESIS,
      root: this.root(),
    };
  }

  static fromState(state) {
    const ledger = new Ledger({ base: state.base });
    for (const [id, rates] of Object.entries(state.snapshots ?? {})) {
      ledger.addSnapshot(id, rates);
    }
    for (const voucher of state.vouchers ?? []) {
      ledger.addVoucher(voucher);
    }
    ledger.finalize();
    for (const voucher of state.vouchers ?? []) {
      if (voucher.hash && ledger.vouchers.get(voucher.id).hash !== voucher.hash) {
        throw new LedgerError('CHAIN_BROKEN', `voucher ${voucher.id} hash mismatch`);
      }
    }
    return ledger;
  }

  #normalizeVoucher(input) {
    if (!input || typeof input.id !== 'string' || !input.id) {
      throw new LedgerError('INVALID_OP', 'voucher id required');
    }
    if (this.vouchers.has(input.id) || this.pending.has(input.id)) {
      throw new LedgerError('DUPLICATE_ID', `voucher ${input.id} already exists`);
    }
    let lamport = input.lamport;
    if (lamport == null) lamport = this.clock + 1;
    if (!Number.isInteger(lamport) || lamport < 1) {
      throw new LedgerError('INVALID_OP', 'lamport must be a positive integer');
    }
    const postings = normalizePostings(input.postings);
    const snapshot = input.snapshot ?? null;
    if (postings.some((p) => p.currency !== this.base) && !snapshot) {
      throw new LedgerError('MISSING_SNAPSHOT',
        `voucher ${input.id} uses non-base currency but declares no snapshot`);
    }
    return { id: input.id, lamport, postings, snapshot, reverses: input.reverses ?? null };
  }

  #accept(rec) {
    this.clock = Math.max(this.clock, rec.lamport);
    if (rec.snapshot && !this.snapshots.has(rec.snapshot)) {
      // Unresolved dependency is pending, not unsatisfiable.
      this.pending.set(rec.id, rec);
      return { pending: true, id: rec.id, invalidated: [] };
    }
    const invalidated = this.#insert(rec);
    return { pending: false, id: rec.id, invalidated, position: this.order.indexOf(rec.id) };
  }

  #applyReversal({ id, target, lamport }) {
    if (this.reversed.has(target)) {
      throw new LedgerError('ALREADY_REVERSED', `voucher ${target} already reversed`);
    }
    const targetRec = this.vouchers.get(target);
    if (targetRec.reverses) {
      throw new LedgerError('INVALID_OP', 'cannot reverse a reversal voucher');
    }
    const rec = this.#normalizeVoucher({
      id,
      lamport: lamport ?? undefined,
      snapshot: targetRec.snapshot,
      reverses: target,
      postings: targetRec.postings.map((p) => ({
        account: p.account,
        currency: p.currency,
        amount: formatDecimal(-p.amount),
      })),
    });
    return this.#accept(rec);
  }

  #insert(rec) {
    for (const p of rec.postings) {
      if (p.currency !== this.base) {
        const snap = this.snapshots.get(rec.snapshot);
        if (!snap || snap[p.currency] === undefined) {
          throw new LedgerError('MISSING_RATE',
            `no rate for ${p.currency} in snapshot ${rec.snapshot}`);
        }
      }
    }
    rec.hash = voucherHash(rec);
    this.vouchers.set(rec.id, rec);
    const pos = this.#positionOf(rec);
    this.order.splice(pos, 0, rec.id);
    this.#recomputeFrom(pos);

    const invalidated = [];
    if (rec.reverses) {
      const target = this.vouchers.get(rec.reverses);
      if (!target) {
        throw new LedgerError('CHAIN_BROKEN',
          `reversal ${rec.id} targets unknown voucher ${rec.reverses}`);
      }
      if (this.reversed.has(rec.reverses)) {
        throw new LedgerError('ALREADY_REVERSED', `voucher ${rec.reverses} already reversed`);
      }
      this.reversed.add(rec.reverses);
      for (const dep of this.#dependentsOf(rec.reverses)) {
        this.invalidated.add(dep);
        invalidated.push(dep);
      }
    } else if (this.#dependsOnInvalidated(rec, pos)) {
      // Newly inserted voucher downstream of a reversed one inherits staleness.
      this.invalidated.add(rec.id);
      invalidated.push(rec.id);
    }

    // Hash-chain cascade: everything after the insertion point is affected.
    invalidated.push(...this.order.slice(pos + 1));

    // Resolve reversals that were waiting for this voucher.
    for (const pending of [...this.pendingReversals]) {
      if (pending.target === rec.id) {
        this.pendingReversals.splice(this.pendingReversals.indexOf(pending), 1);
        invalidated.push(...this.#applyReversal(pending).invalidated);
      }
    }
    return [...new Set(invalidated)].sort();
  }

  #positionOf(rec) {
    let lo = 0;
    let hi = this.order.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const other = this.vouchers.get(this.order[mid]);
      if (other.lamport < rec.lamport
        || (other.lamport === rec.lamport && other.id < rec.id)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  #dependentsOf(targetId) {
    const pos = this.order.indexOf(targetId);
    const accounts = new Set(this.vouchers.get(targetId).postings.map((p) => p.account));
    const result = [];
    for (let i = pos + 1; i < this.order.length; i++) {
      const rec = this.vouchers.get(this.order[i]);
      if (rec.reverses) continue; // corrections are never marked stale
      if (rec.postings.some((p) => accounts.has(p.account))) {
        result.push(rec.id);
        for (const p of rec.postings) accounts.add(p.account);
      }
    }
    return result;
  }

  #dependsOnInvalidated(rec, pos) {
    const accounts = new Set(rec.postings.map((p) => p.account));
    for (let i = pos - 1; i >= 0; i--) {
      const other = this.vouchers.get(this.order[i]);
      if (other.postings.some((p) => accounts.has(p.account))) {
        if (this.reversed.has(other.id) || this.invalidated.has(other.id)) return true;
        for (const p of other.postings) accounts.add(p.account);
      }
    }
    return false;
  }

  #recomputeFrom(pos) {
    this.chainLinks.length = this.order.length;
    for (let i = pos; i < this.order.length; i++) {
      const prev = i === 0 ? GENESIS : this.chainLinks[i - 1];
      this.chainLinks[i] = sha256('chain', prev, this.vouchers.get(this.order[i]).hash);
    }
    let balances = { ...(pos === 0 ? {} : this.prefixBalances[pos]) };
    this.prefixBalances.length = pos + 1;
    for (let i = pos; i < this.order.length; i++) {
      balances = this.#apply(balances, this.vouchers.get(this.order[i]));
      this.prefixBalances.push(balances);
    }
  }

  #apply(balances, rec) {
    const next = { ...balances };
    for (const p of rec.postings) {
      const baseAmount = p.currency === this.base
        ? p.amount
        : (p.amount * this.snapshots.get(rec.snapshot)[p.currency]) / SCALE;
      const value = (next[p.account] ?? 0n) + baseAmount;
      if (value === 0n) delete next[p.account];
      else next[p.account] = value;
    }
    return next;
  }

  #balancesHash() {
    const raw = this.prefixBalances[this.order.length];
    const canonObj = {};
    for (const account of Object.keys(raw)) canonObj[account] = raw[account].toString();
    return sha256('balances', canonical(canonObj));
  }
}
