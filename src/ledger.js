// Audit ledger with exact interval propagation over two strata:
//   - audited stratum: items with an observed actual value; per-item error
//     interval [min(0, actual - claimed), max(0, actual - claimed)] is split
//     by sign and summed exactly (BigInt rationals, no floats).
//   - unaudited stratum: never merged into the bound; it is reported as
//     E_PENDING instead of being treated as zero or as unsatisfiable.
//
// Every mutation appends to a hash-chained certificate; explain() exposes the
// chain head so stale explanations are detectable via verify().

import { createHash } from 'node:crypto';
import { Rational, ZERO, ONE } from './rational.js';

export class AuditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
  }
}

function parseClaimed(value) {
  if (value !== null && typeof value === 'object') {
    return new Rational(value.num, value.den ?? 1n);
  }
  if (typeof value === 'string') {
    const m = value.match(/^(-?\d+)(?:\/(\d+))?$/);
    if (!m) throw new AuditError('E_RATIONAL', `bad rational: ${value}`);
    return new Rational(BigInt(m[1]), m[2] ? BigInt(m[2]) : 1n);
  }
  return new Rational(value);
}

export class AuditLedger {
  constructor() {
    this.items = new Map(); // insertion-ordered: id -> { claimed, actual|null }
    this.version = 0;
    this.certificate = '0'.repeat(64);
    this.auditedCount = 0;
    this.negSum = ZERO; // sum of negative error parts over audited stratum
    this.posSum = ZERO; // sum of positive error parts over audited stratum
  }

  _require(id) {
    const item = this.items.get(id);
    if (!item) throw new AuditError('E_ITEM', `unknown item: ${id}`);
    return item;
  }

  _errorOf(item) {
    return item.actual.sub(item.claimed);
  }

  _addToLayer(item) {
    const err = this._errorOf(item);
    if (err.sign() < 0) this.negSum = this.negSum.add(err);
    else this.posSum = this.posSum.add(err);
  }

  _removeFromLayer(item) {
    const err = this._errorOf(item);
    if (err.sign() < 0) this.negSum = this.negSum.sub(err);
    else this.posSum = this.posSum.sub(err);
  }

  _commit(op) {
    this.version += 1;
    this.certificate = createHash('sha256')
      .update(this.certificate)
      .update('')
      .update(JSON.stringify(op))
      .digest('hex');
  }

  addItem({ id, claimedNum, claimedDen } = {}) {
    if (id === undefined || id === null || id === '') {
      throw new AuditError('E_ITEM', 'id required');
    }
    if (claimedNum === undefined) {
      throw new AuditError('E_ITEM', 'claimedNum required');
    }
    if (this.items.has(id)) {
      throw new AuditError('E_ITEM', `duplicate id: ${id}`);
    }
    this.items.set(id, {
      claimed: new Rational(claimedNum, claimedDen ?? 1n),
      actual: null,
    });
    this._commit({ op: 'addItem', id, claimedNum: String(claimedNum), claimedDen: String(claimedDen ?? 1n) });
    return { id, version: this.version };
  }

  audit({ id, actualNum, actualDen } = {}) {
    const item = this._require(id);
    if (actualNum === undefined) {
      throw new AuditError('E_ITEM', 'actualNum required');
    }
    if (item.actual !== null) {
      this._removeFromLayer(item); // re-audit: replace previous observation
    } else {
      this.auditedCount += 1;
    }
    item.actual = new Rational(actualNum, actualDen ?? 1n);
    this._addToLayer(item);
    this._commit({ op: 'audit', id, actualNum: String(actualNum), actualDen: String(actualDen ?? 1n) });
    return { id, version: this.version };
  }

  correct({ id, newClaimed } = {}) {
    const item = this._require(id);
    if (newClaimed === undefined) {
      throw new AuditError('E_ITEM', 'newClaimed required');
    }
    const audited = item.actual !== null;
    if (audited) this._removeFromLayer(item); // keep layer sums consistent
    item.claimed = parseClaimed(newClaimed);
    if (audited) this._addToLayer(item);
    this._commit({ op: 'correct', id, newClaimed: item.claimed.toString() });
    return { id, version: this.version };
  }

  // confidence c in (0, 1]; the audited-stratum sums are inflated by 1/c so
  // the reported interval stays conservative under sampling. c = 1 yields the
  // exact propagated sum.
  bound({ confidenceNum, confidenceDen } = {}) {
    if (confidenceNum === undefined) {
      throw new AuditError('E_CONF', 'confidenceNum required');
    }
    const conf = new Rational(confidenceNum, confidenceDen ?? 1n);
    if (conf.cmp(ZERO) <= 0 || conf.cmp(ONE) > 0) {
      throw new AuditError('E_CONF', `confidence must be in (0,1], got ${conf}`);
    }
    if (this.auditedCount === 0) {
      throw new AuditError('E_LAYER', 'audited stratum is empty');
    }
    const pending = this.auditedCount < this.items.size;
    const lower = this.negSum.div(conf);
    const upper = this.posSum.div(conf);
    const witnessIds = [];
    for (const [id, item] of this.items) {
      if (item.actual !== null && !this._errorOf(item).isZero()) witnessIds.push(id);
    }
    witnessIds.sort();
    const result = {
      lower: lower.toString(),
      upper: upper.toString(),
      status: pending ? 'pending' : 'ok',
      witnessIds,
    };
    if (pending) result.code = 'E_PENDING';
    return result;
  }

  explain() {
    if (this.auditedCount === 0) {
      throw new AuditError('E_LAYER', 'audited stratum is empty');
    }
    const items = [];
    for (const [id, item] of this.items) {
      if (item.actual === null) continue;
      const err = this._errorOf(item);
      items.push({
        id,
        claimed: item.claimed.toString(),
        actual: item.actual.toString(),
        interval: [Rational.min(ZERO, err).toString(), Rational.max(ZERO, err).toString()],
      });
    }
    items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const unaudited = this.items.size - this.auditedCount;
    return {
      version: this.version,
      certificate: this.certificate,
      strata: {
        audited: {
          count: this.auditedCount,
          lower: this.negSum.toString(),
          upper: this.posSum.toString(),
        },
        unaudited: {
          count: unaudited,
          status: unaudited > 0 ? 'E_PENDING' : 'ok',
        },
      },
      items,
    };
  }

  // A certificate from explain() is valid only while no mutation occurred.
  verify(cert) {
    return Boolean(cert)
      && cert.version === this.version
      && cert.certificate === this.certificate;
  }
}
