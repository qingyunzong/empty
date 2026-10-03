import { createHash } from 'node:crypto';
import { rat, add, sub, cmp, isZero, fmt, parseRat, ZERO, ONE } from './rational.js';

export class AuditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
  }
}

const GENESIS = '0'.repeat(64);

function hashEntry(entry) {
  return createHash('sha256').update(JSON.stringify(entry)).digest('hex');
}

// AuditLedger tracks expense items, audited actuals, and corrections, and
// propagates per-item misstatement intervals into an exact rational bound.
//
// Per audited item, the error interval is
//   [min(0, actual - claimed), max(0, actual - claimed)]
// so each item contributes only its own sign of deviation. The population
// interval is the exact rational sum over the audited stratum only; unaudited
// items form a pending stratum that is reported as E_PENDING and is never
// merged into the bound.
export class AuditLedger {
  #items = new Map();
  #chain = [];
  #head = GENESIS;
  #version = 0;

  #record(op, payload) {
    const entry = { seq: this.#version, op, payload, prev: this.#head };
    entry.hash = hashEntry({
      seq: entry.seq,
      op: entry.op,
      payload: entry.payload,
      prev: entry.prev,
    });
    this.#chain.push(entry);
    this.#head = entry.hash;
    this.#version += 1;
    return entry;
  }

  #require(id) {
    const item = this.#items.get(id);
    if (!item) throw new AuditError('E_ITEM', `unknown item: ${id}`);
    return item;
  }

  addItem({ id, claimedNum, claimedDen = 1 }) {
    if (id === undefined || id === null) throw new AuditError('E_ITEM', 'item id required');
    if (this.#items.has(id)) throw new AuditError('E_DUP', `duplicate item: ${id}`);
    const claimed = rat(claimedNum, claimedDen);
    this.#items.set(id, { id, claimed, actual: null, audited: false });
    this.#record('addItem', { id, claimed: fmt(claimed) });
    return { id, claimed: fmt(claimed) };
  }

  audit({ id, actualNum, actualDen = 1 }) {
    const item = this.#require(id);
    const actual = rat(actualNum, actualDen);
    item.actual = actual;
    item.audited = true;
    this.#record('audit', { id, actual: fmt(actual) });
    return { id, actual: fmt(actual) };
  }

  // Corrects the claimed amount. For an audited item this changes its error
  // interval (and therefore the stratum sum, which is derived on demand) and
  // appends to the certificate chain, invalidating any prior explain output.
  correct({ id, newClaimed, newClaimedNum, newClaimedDen = 1 }) {
    const item = this.#require(id);
    const claimed =
      newClaimed !== undefined ? parseRat(newClaimed) : rat(newClaimedNum, newClaimedDen);
    const previous = item.claimed;
    item.claimed = claimed;
    this.#record('correct', {
      id,
      from: fmt(previous),
      to: fmt(claimed),
      audited: item.audited,
    });
    return { id, claimed: fmt(claimed), audited: item.audited };
  }

  #intervals() {
    const intervals = [];
    for (const item of this.#items.values()) {
      if (!item.audited) continue;
      const diff = sub(item.actual, item.claimed);
      intervals.push({
        id: item.id,
        diff,
        lower: cmp(diff, ZERO) < 0 ? diff : ZERO,
        upper: cmp(diff, ZERO) > 0 ? diff : ZERO,
      });
    }
    return intervals;
  }

  #aggregate() {
    let lower = ZERO;
    let upper = ZERO;
    const witnessIds = [];
    for (const iv of this.#intervals()) {
      lower = add(lower, iv.lower);
      upper = add(upper, iv.upper);
      if (!isZero(iv.diff)) witnessIds.push(iv.id);
    }
    return { lower, upper, witnessIds };
  }

  #pendingIds() {
    return [...this.#items.values()].filter((i) => !i.audited).map((i) => i.id);
  }

  bound({ confidenceNum, confidenceDen = 1 } = {}) {
    if (this.#items.size === 0) {
      throw new AuditError('E_LAYER', 'empty population: no items to bound');
    }
    const confidence = rat(confidenceNum, confidenceDen);
    if (!(cmp(confidence, ZERO) > 0 && cmp(confidence, ONE) < 0)) {
      throw new AuditError('E_CONF', `confidence out of range (0,1): ${fmt(confidence)}`);
    }
    const { lower, upper, witnessIds } = this.#aggregate();
    const pending = this.#pendingIds();
    return {
      lower: fmt(lower),
      upper: fmt(upper),
      status: pending.length > 0 ? 'E_PENDING' : 'OK',
      witnessIds,
      confidence: fmt(confidence),
      version: this.#version,
      head: this.#head,
    };
  }

  explain() {
    if (this.#items.size === 0) {
      throw new AuditError('E_LAYER', 'empty population: nothing to explain');
    }
    const intervals = this.#intervals();
    const { lower, upper, witnessIds } = this.#aggregate();
    return {
      version: this.#version,
      head: this.#head,
      layers: {
        audited: intervals.map((iv) => iv.id),
        pending: this.#pendingIds(),
      },
      intervals: intervals.map((iv) => ({
        id: iv.id,
        lower: fmt(iv.lower),
        upper: fmt(iv.upper),
      })),
      lower: fmt(lower),
      upper: fmt(upper),
      witnessIds,
      chain: this.#chain.map((entry) => ({ ...entry })),
    };
  }

  // An explain certificate is valid only while the chain head and version
  // match; any addItem/audit/correct afterwards invalidates it.
  verifyExplain(cert) {
    return Boolean(cert) && cert.head === this.#head && cert.version === this.#version;
  }
}
