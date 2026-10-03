import { AuditError, E_TIME_ORDER, E_TOMBSTONE, E_REF } from './errors.js';
import { normalizeEvent, parseTime } from './event.js';
import { visibleVersions } from './algebra.js';
import { AccountIndex } from './index.js';

function aggregate(account, valid, txSeq, versions) {
  let balance = 0;
  let limit = 0;
  for (const v of versions) {
    if (v.amount !== null) balance += v.amount; // sum ignores NULL amount
    if (v.limit !== null) limit += v.limit;
  }
  return {
    account,
    valid,
    tx: txSeq,
    balance,
    limit,
    count: versions.length, // count counts versions
    versions: versions.map((v) => v.id).sort(),
  };
}

export class AuditDB {
  constructor() {
    this.events = [];                 // append-only log, txSeq ascending
    this.byId = new Map();            // id -> event
    this.accounts = new Map();        // account -> AccountIndex
    this.lastTxSeq = 0;
  }

  load(rawEvents) {
    for (const raw of rawEvents) this.append(raw);
    return this;
  }

  append(raw) {
    const e = normalizeEvent(raw);
    if (this.byId.has(e.id)) {
      throw new AuditError(E_REF, `duplicate event id ${e.id}`);
    }
    if (e.txSeq <= this.lastTxSeq) {
      throw new AuditError(E_TIME_ORDER,
        `event ${e.id}: txSeq ${e.txSeq} must be greater than last txSeq ${this.lastTxSeq}`);
    }
    if (e.supersedes !== null) {
      const target = this.byId.get(e.supersedes);
      if (!target) {
        throw new AuditError(E_REF, `event ${e.id}: unknown supersedes target ${e.supersedes}`);
      }
      if (target.account !== e.account) {
        throw new AuditError(E_REF, `event ${e.id}: cannot supersede event of another account`);
      }
      if (target.tombstone) {
        throw new AuditError(E_TOMBSTONE,
          `event ${e.id}: cannot supersede tombstone ${target.id} (deletes are final)`);
      }
      e.root = target.root;
    } else {
      e.root = e.id;
    }
    this.lastTxSeq = e.txSeq;
    this.events.push(e);
    this.byId.set(e.id, e);
    let idx = this.accounts.get(e.account);
    if (!idx) {
      idx = new AccountIndex();
      this.accounts.set(e.account, idx);
    }
    idx.add(e);
    return e;
  }

  // Indexed asOf: touches only the target account's version chains.
  asOf(account, valid, txSeq = Number.MAX_SAFE_INTEGER) {
    const validMs = parseTime(valid, 'valid');
    if (validMs === null) {
      throw new AuditError(E_TIME_ORDER, 'asOf requires a valid time');
    }
    const idx = this.accounts.get(account);
    const versions = idx ? idx.visibleAt(validMs, txSeq) : [];
    versions.sort((a, b) => a.txSeq - b.txSeq);
    return aggregate(account, valid, txSeq, versions);
  }

  // Brute-force reference implementation (full scan, relational algebra).
  asOfBruteForce(account, valid, txSeq = Number.MAX_SAFE_INTEGER) {
    const validMs = parseTime(valid, 'valid');
    if (validMs === null) {
      throw new AuditError(E_TIME_ORDER, 'asOf requires a valid time');
    }
    const versions = visibleVersions(this.events, account, validMs, txSeq);
    versions.sort((a, b) => a.txSeq - b.txSeq);
    return aggregate(account, valid, txSeq, versions);
  }
}
