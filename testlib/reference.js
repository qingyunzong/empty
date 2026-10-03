// Independent brute-force reference implementation used to cross-check the
// incremental Ledger. No checkpoints, no caching: every mutation recomputes
// everything from scratch with naive O(n^2) scans.
import { merkleRoot, GENESIS, EMPTY_ROOT } from '../src/hash.js';
import { hashRecord } from '../src/ledger.js';

function cmp(a, b) {
  if (a.pos !== b.pos) return a.pos < b.pos ? -1 : 1;
  if (a.lamport !== b.lamport) return a.lamport < b.lamport ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function accountsOf(record) {
  return [...new Set(record.entries.map((e) => e.account))];
}

export class ReferenceLedger {
  constructor() {
    this.snapshots = new Map();
    this.records = [];
    this.byId = new Map();
  }

  addSnapshot({ id, pair, rate }) {
    if (this.snapshots.has(id)) {
      const existing = this.snapshots.get(id);
      if (existing.rate !== rate || existing.pair !== pair) {
        const err = new Error('snapshot conflict');
        err.code = 'SNAPSHOT_CONFLICT';
        throw err;
      }
      return;
    }
    this.snapshots.set(id, { id, pair, rate });
  }

  addVoucher({ id, entries, deps = [], pos = null, kind = 'voucher', ref = null, basisExclude = null }) {
    if (this.byId.has(id)) {
      const err = new Error('duplicate');
      err.code = 'DUPLICATE_ID';
      throw err;
    }
    for (const dep of deps) {
      if (!this.byId.has(dep)) {
        const err = new Error('missing dep');
        err.code = 'MISSING_DEPENDENCY';
        throw err;
      }
    }
    for (const entry of entries) {
      if (entry.currency !== undefined) {
        if (!entry.snapshot || !this.snapshots.has(entry.snapshot)) {
          const err = new Error('missing snapshot');
          err.code = 'MISSING_SNAPSHOT';
          throw err;
        }
      }
    }
    const lamport = 1 + Math.max(0, ...deps.map((d) => this.byId.get(d).lamport));
    const record = {
      id,
      kind,
      entries: entries.map((e) => ({ ...e })),
      deps: deps.slice(),
      pos: pos ?? Math.max(lamport, ...deps.map((d) => this.byId.get(d).pos + 1)),
      lamport,
      ref,
      seq: this.records.length,
      prevHash: this.records.length ? this.records[this.records.length - 1].hash : GENESIS,
    };
    record.basis = this._basisFor(record, basisExclude);
    record.hash = hashRecord(record);
    this.records.push(record);
    this.byId.set(id, record);
    return record;
  }

  reverse({ id, target }) {
    const targetRecord = this.byId.get(target);
    if (!targetRecord) {
      const err = new Error('missing target');
      err.code = 'MISSING_DEPENDENCY';
      throw err;
    }
    if (this.records.some((v) => v.kind === 'reversal' && v.ref === target)) {
      const err = new Error('already reverted');
      err.code = 'ALREADY_REVERTED';
      throw err;
    }
    const basisExclude = new Set(
      this.records
        .filter((v) => v.kind === 'voucher' && v.id !== target && Object.values(v.basis).includes(targetRecord.hash))
        .map((v) => v.id),
    );
    const entries = targetRecord.entries.map((e) => ({ ...e, amount: -e.amount }));
    return this.addVoucher({ id, entries, deps: [target], kind: 'reversal', ref: target, basisExclude });
  }

  _ordered() {
    return this.records.slice().sort(cmp);
  }

  _basisFor(record, basisExclude) {
    if (record.kind === 'reversal') return {};
    const valid = this._evaluate().valid;
    const wanted = new Set(accountsOf(record));
    const basis = {};
    for (const v of this._ordered()) {
      if (!valid.has(v.id)) continue;
      if (basisExclude && basisExclude.has(v.id)) continue;
      if (cmp(v, record) >= 0) break;
      for (const account of accountsOf(v)) {
        if (wanted.has(account)) basis[account] = v.hash;
      }
    }
    for (const account of wanted) {
      if (!(account in basis)) basis[account] = GENESIS;
    }
    return basis;
  }

  _evaluate() {
    // Mirrors Ledger._recompute pass semantics exactly (persistent flags,
    // stale reads for later vouchers, fixpoint over passes), but always
    // recomputes the whole ledger from genesis with naive scans.
    for (const record of this.records) {
      if (record.invalid === undefined) record.invalid = false;
    }
    let previousSignature = null;
    for (let iteration = 0; iteration < 100; iteration++) {
      const marked = new Set();
      for (const reversal of this.records) {
        if (reversal.kind !== 'reversal' || reversal.invalid) continue;
        const target = this.byId.get(reversal.ref);
        for (const v of this.records) {
          if (v.kind !== 'voucher' || v.id === target.id) continue;
          if (v.seq >= reversal.seq) continue;
          if (Object.values(v.basis).includes(target.hash)) marked.add(v.id);
        }
      }
      const basisState = new Map();
      const signature = [];
      for (const v of this._ordered()) {
        let bad = marked.has(v.id) || v.deps.some((d) => this.byId.get(d).invalid);
        if (!bad) {
          for (const [account, hash] of Object.entries(v.basis)) {
            if ((basisState.get(account) ?? GENESIS) !== hash) {
              bad = true;
              break;
            }
          }
        }
        v.invalid = bad;
        signature.push(bad ? '1' : '0');
        if (!bad) {
          for (const account of accountsOf(v)) basisState.set(account, v.hash);
        }
      }
      const current = signature.join('');
      if (current === previousSignature) break;
      previousSignature = current;
    }
    const invalid = new Set(this.records.filter((rec) => rec.invalid).map((rec) => rec.id));
    return { valid: new Set(this.records.filter((rec) => !rec.invalid).map((rec) => rec.id)), invalid };
  }

  state() {
    const { valid, invalid } = this._evaluate();
    const balances = new Map();
    const validHashes = [];
    for (const v of this._ordered()) {
      if (!valid.has(v.id)) continue;
      validHashes.push(v.hash);
      for (const entry of v.entries) {
        const amount = entry.currency !== undefined
          ? Math.round(entry.amount * this.snapshots.get(entry.snapshot).rate)
          : entry.amount;
        balances.set(entry.account, (balances.get(entry.account) ?? 0) + amount);
      }
    }
    return {
      root: validHashes.length ? merkleRoot(validHashes) : EMPTY_ROOT,
      balances,
      invalidIds: this._ordered().filter((v) => invalid.has(v.id)).map((v) => v.id),
    };
  }
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
