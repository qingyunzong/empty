import { canonical, sha256hex, merkleRoot, merkleProof, GENESIS, EMPTY_ROOT } from './hash.js';

export class LedgerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function hashRecord(record) {
  return sha256hex('voucher:' + canonical({
    id: record.id,
    kind: record.kind,
    entries: record.entries,
    deps: record.deps,
    pos: record.pos,
    lamport: record.lamport,
    ref: record.ref,
    basis: record.basis,
    prevHash: record.prevHash,
  }));
}

export function recordView(record) {
  return {
    id: record.id,
    kind: record.kind,
    entries: record.entries,
    deps: record.deps,
    pos: record.pos,
    lamport: record.lamport,
    ref: record.ref,
    basis: record.basis,
    prevHash: record.prevHash,
    hash: record.hash,
    seq: record.seq,
  };
}

function compareKeys(a, b) {
  if (a.pos !== b.pos) return a.pos < b.pos ? -1 : 1;
  if (a.lamport !== b.lamport) return a.lamport < b.lamport ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function accountsOf(record) {
  const seen = new Set();
  for (const entry of record.entries) seen.add(entry.account);
  return [...seen];
}

export class Ledger {
  constructor() {
    this.vouchers = new Map();
    this.snapshots = new Map();
    this.chain = [];
    this.replay = [];
    this.checkpoints = [{ balances: new Map(), basis: new Map() }];
    this.lastHash = GENESIS;
    this.root = EMPTY_ROOT;
    this.log = [];
    this.chainMismatches = [];
  }

  get chainTip() {
    return this.lastHash;
  }

  get balances() {
    return this.checkpoints[this.checkpoints.length - 1].balances;
  }

  get chainStatus() {
    return { ok: this.chainMismatches.length === 0, mismatches: this.chainMismatches };
  }

  validRecords() {
    return this.replay.filter((v) => !v.invalid);
  }

  invalidRecords() {
    return this.replay.filter((v) => v.invalid);
  }

  invalidIds() {
    return this.invalidRecords().map((v) => v.id);
  }

  addSnapshot({ id, pair, rate }) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new LedgerError('BAD_INPUT', 'snapshot id required');
    }
    if (typeof rate !== 'number' || !Number.isFinite(rate)) {
      throw new LedgerError('BAD_INPUT', 'snapshot rate must be a finite number');
    }
    const existing = this.snapshots.get(id);
    if (existing) {
      if (existing.rate !== rate || existing.pair !== pair) {
        throw new LedgerError('SNAPSHOT_CONFLICT', `snapshot ${id} already exists with different value`, { id });
      }
      return existing;
    }
    const snapshot = { id, pair, rate };
    this.snapshots.set(id, snapshot);
    this.log.push({ op: 'snapshot', params: { id, pair, rate } });
    return snapshot;
  }

  addVoucher({ id, entries, deps = [], pos = null, kind = 'voucher', ref = null, _basisExclude = null }) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new LedgerError('BAD_INPUT', 'voucher id required');
    }
    if (this.vouchers.has(id)) {
      throw new LedgerError('DUPLICATE_ID', `duplicate voucher id ${id}`, { id });
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new LedgerError('BAD_INPUT', 'voucher requires at least one entry', { id });
    }
    for (const dep of deps) {
      if (!this.vouchers.has(dep)) {
        throw new LedgerError('MISSING_DEPENDENCY', `unknown dependency voucher ${dep}`, { id, dependency: dep });
      }
    }
    for (const entry of entries) {
      if (!entry || typeof entry.account !== 'string' || typeof entry.amount !== 'number') {
        throw new LedgerError('BAD_INPUT', 'entry requires account (string) and amount (number)', { id });
      }
      if (entry.currency !== undefined) {
        if (!entry.snapshot) {
          throw new LedgerError('MISSING_SNAPSHOT', `entry in currency ${entry.currency} requires an fx snapshot`, { id, account: entry.account });
        }
        if (!this.snapshots.has(entry.snapshot)) {
          throw new LedgerError('MISSING_SNAPSHOT', `unknown fx snapshot ${entry.snapshot}`, { id, snapshot: entry.snapshot });
        }
      }
    }

    const lamport = 1 + Math.max(0, ...deps.map((d) => this.vouchers.get(d).lamport));
    const position = pos ?? Math.max(lamport, ...deps.map((d) => this.vouchers.get(d).pos + 1));
    const record = {
      id,
      kind,
      entries: entries.map((e) => ({ ...e })),
      deps: deps.slice(),
      pos: position,
      lamport,
      ref,
      seq: this.chain.length,
      invalid: false,
    };

    const index = this._insertIndex(record);
    const basis = {};
    if (kind === 'reversal') {
      // Reversals are authoritative corrections: they do not read state,
      // so they carry no basis and can never be basis-invalidated.
    } else if (_basisExclude === null) {
      const basisState = this.checkpoints[index].basis;
      for (const account of accountsOf(record)) {
        basis[account] = basisState.get(account) ?? GENESIS;
      }
    } else {
      const wanted = new Set(accountsOf(record));
      for (let i = 0; i < index; i++) {
        const v = this.replay[i];
        if (v.invalid || _basisExclude.has(v.id)) continue;
        for (const account of accountsOf(v)) {
          if (wanted.has(account)) basis[account] = v.hash;
        }
      }
      for (const account of wanted) {
        if (!(account in basis)) basis[account] = GENESIS;
      }
    }
    record.basis = basis;
    record.prevHash = this.lastHash;
    record.hash = hashRecord(record);
    record.applied = record.entries.map((e) => [
      e.account,
      e.currency !== undefined ? Math.round(e.amount * this.snapshots.get(e.snapshot).rate) : e.amount,
    ]);

    this.vouchers.set(id, record);
    this.chain.push(record);
    this.lastHash = record.hash;
    this.replay.splice(index, 0, record);
    let recomputeFrom = index;
    if (_basisExclude !== null) {
      for (let i = 0; i < this.replay.length; i++) {
        const v = this.replay[i];
        if (_basisExclude.has(v.id) || v.id === ref) {
          recomputeFrom = Math.min(recomputeFrom, i);
          break;
        }
      }
    }
    this._recompute(recomputeFrom);

    if (kind === 'reversal') {
      this.log.push({ op: 'reverse', params: { id, target: ref }, record: recordView(record) });
    } else {
      this.log.push({ op: 'voucher', params: { id, entries: record.entries, deps: record.deps, pos }, record: recordView(record) });
    }
    return record;
  }

  reverse({ id, target }) {
    const targetRecord = this.vouchers.get(target);
    if (!targetRecord) {
      throw new LedgerError('MISSING_DEPENDENCY', `unknown target voucher ${target}`, { id, target });
    }
    if (targetRecord.kind !== 'voucher') {
      throw new LedgerError('INVALID_TARGET', `cannot reverse ${target}: not a voucher`, { id, target });
    }
    if (this.chain.some((v) => v.kind === 'reversal' && v.ref === target)) {
      throw new LedgerError('ALREADY_REVERTED', `voucher ${target} already reversed`, { id, target });
    }
    const entries = targetRecord.entries.map((e) => ({ ...e, amount: -e.amount }));
    const basisExclude = new Set(
      this.chain
        .filter((v) => v.kind === 'voucher' && v.id !== target && Object.values(v.basis).includes(targetRecord.hash))
        .map((v) => v.id),
    );
    return this.addVoucher({ id, entries, deps: [target], kind: 'reversal', ref: target, _basisExclude: basisExclude });
  }

  proof(id) {
    const record = this.vouchers.get(id);
    if (!record) {
      throw new LedgerError('VOUCHER_NOT_FOUND', `unknown voucher ${id}`, { id });
    }
    if (record.invalid) {
      return { id, valid: false, proof: null, root: this.root };
    }
    const valid = this.validRecords();
    const leaves = valid.map((v) => v.hash);
    const index = valid.findIndex((v) => v.id === id);
    return { id, valid: true, leaf: record.hash, proof: merkleProof(leaves, index), root: this.root };
  }

  serialize() {
    return this.log.map((line) => JSON.stringify(line)).join('\n') + (this.log.length ? '\n' : '');
  }

  static load(lines) {
    const ledger = new Ledger();
    for (const line of lines) {
      const text = typeof line === 'string' ? line.trim() : '';
      if (!text) continue;
      const entry = JSON.parse(text);
      if (entry.op === 'snapshot') {
        ledger.addSnapshot(entry.params);
      } else if (entry.op === 'voucher') {
        const created = ledger.addVoucher(entry.params);
        ledger._checkStoredRecord(entry.record, created);
      } else if (entry.op === 'reverse') {
        const created = ledger.reverse(entry.params);
        ledger._checkStoredRecord(entry.record, created);
      } else {
        throw new LedgerError('BAD_INPUT', `unknown log op ${entry.op}`);
      }
    }
    return ledger;
  }

  _checkStoredRecord(stored, created) {
    if (!stored) return;
    if (JSON.stringify(stored) !== JSON.stringify(recordView(created))) {
      this.chainMismatches.push({ seq: created.seq, id: created.id });
    }
  }

  _insertIndex(record) {
    let index = this.replay.length;
    for (let i = 0; i < this.replay.length; i++) {
      if (compareKeys(record, this.replay[i]) < 0) {
        index = i;
        break;
      }
    }
    return index;
  }

  _markedSet() {
    const marked = new Set();
    for (const reversal of this.chain) {
      if (reversal.kind !== 'reversal' || reversal.invalid) continue;
      const target = this.vouchers.get(reversal.ref);
      for (const v of this.chain) {
        if (v.kind !== 'voucher' || v.id === target.id) continue;
        if (v.seq >= reversal.seq) continue;
        if (Object.values(v.basis).includes(target.hash)) marked.add(v.id);
      }
    }
    return marked;
  }

  _recompute(fromIndex) {
    let previousSignature = null;
    for (let iteration = 0; iteration < 64; iteration++) {
      const marked = this._markedSet();
      const balances = new Map(this.checkpoints[fromIndex].balances);
      const basisState = new Map(this.checkpoints[fromIndex].basis);
      this.checkpoints.length = fromIndex + 1;
      for (let i = fromIndex; i < this.replay.length; i++) {
        const v = this.replay[i];
        let invalid = marked.has(v.id);
        if (!invalid) {
          for (const dep of v.deps) {
            if (this.vouchers.get(dep).invalid) { invalid = true; break; }
          }
        }
        if (!invalid) {
          for (const [account, hash] of Object.entries(v.basis)) {
            if ((basisState.get(account) ?? GENESIS) !== hash) { invalid = true; break; }
          }
        }
        v.invalid = invalid;
        if (!invalid) {
          for (const [account, amount] of v.applied) {
            balances.set(account, (balances.get(account) ?? 0) + amount);
          }
          for (const account of accountsOf(v)) basisState.set(account, v.hash);
        }
        this.checkpoints.push({ balances: new Map(balances), basis: new Map(basisState) });
      }
      const signature = this.replay.map((v) => (v.invalid ? '1' : '0')).join('');
      if (signature === previousSignature) break;
      previousSignature = signature;
    }
    this.root = merkleRoot(this.validRecords().map((v) => v.hash));
  }
}
