import {
  normalize, union, difference, contains, gaps, overlapReport, validateInterval,
} from './intervals.js';
import { issueCert, verifyChain, digest } from './cert.js';
import { patchError, unknownError } from './errors.js';

export const KNOWN_SOURCES = ['valid', 'frozen', 'exempt'];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class AuditService {
  constructor() {
    this.state = { valid: [], frozen: [], exempt: [], unknown: [] };
    this.rawLog = { valid: [], frozen: [], exempt: [], unknown: [] };
    this.certs = [];
    this.patches = [];
  }

  snapshot() {
    return clone(this.state);
  }

  #commit({ inputDigest, ops, cause = null }) {
    const output = this.snapshot();
    const cert = issueCert({
      seq: this.certs.length,
      prevId: this.certs.length ? this.certs[this.certs.length - 1].id : null,
      inputDigest,
      ops,
      output,
      cause,
    });
    this.certs.push(cert);
    return cert;
  }

  // Register a batch of intervals for a source. Unknown sources are kept as
  // PENDING evidence instead of being rejected or treated as unsatisfiable.
  importBatch({ source, intervals }, { strict = false } = {}) {
    if (typeof source !== 'string' || source.length === 0) {
      throw unknownError('source must be a non-empty string', { source });
    }
    const known = KNOWN_SOURCES.includes(source);
    if (!known && strict) {
      throw unknownError(`unknown interval source: ${source}`, { source });
    }
    const key = known ? source : 'unknown';
    const batch = intervals.map(validateInterval);
    const ops = [{
      op: 'import',
      source: key,
      declaredSource: source,
      count: batch.length,
      intervals: clone(batch),
    }];
    this.state[key] = normalize([...this.state[key], ...batch]);
    this.rawLog[key].push(...clone(batch));
    const cert = this.#commit({ inputDigest: digest({ source, intervals: batch }), ops });
    return { cert, status: known ? 'COMMITTED' : 'PENDING' };
  }

  // Point query with priority frozen > exempt > valid > unknown(PENDING).
  query(point) {
    if (contains(this.state.frozen, point)) return { point, status: 'FROZEN' };
    if (contains(this.state.exempt, point)) return { point, status: 'EXEMPT' };
    if (contains(this.state.valid, point)) return { point, status: 'VALID' };
    if (contains(this.state.unknown, point)) return { point, status: 'PENDING' };
    return { point, status: 'UNSATISFIED' };
  }

  report(bound) {
    const coverage = union(this.state.valid, this.state.unknown);
    const result = {
      normalized: this.snapshot(),
      overlaps: {},
    };
    for (const key of Object.keys(this.rawLog)) {
      result.overlaps[key] = overlapReport(this.rawLog[key]);
    }
    if (bound !== undefined) {
      result.gaps = gaps(this.state.valid, bound);
      result.coverageGaps = gaps(coverage, bound);
    }
    return result;
  }

  // Reverse interval patch: subtract wrongly registered ranges and/or add
  // back wrongly removed ones. Proves the old cert's invalidation reason and
  // the new cert's coverage via the chained certificate it issues.
  applyPatch({ reason, add = [], subtract = [], targetCertId } = {}) {
    const target = this.certs[this.certs.length - 1];
    if (!target) throw patchError('no certificate exists to patch');
    if (targetCertId !== undefined && targetCertId !== target.id) {
      throw patchError('patch targets a stale certificate', {
        expected: target.id, actual: targetCertId,
      });
    }
    if (typeof reason !== 'string' || reason.length === 0) {
      throw patchError('patch requires a non-empty reason');
    }
    const addSet = add.map(validateInterval);
    const subSet = subtract.map(validateInterval);
    if (addSet.length === 0 && subSet.length === 0) {
      throw patchError('no-op patch: add and subtract are both empty');
    }
    const next = union(difference(this.state.valid, subSet), addSet);
    if (digest(next) === digest(this.state.valid)) {
      throw patchError('no-op patch: state would be unchanged');
    }
    this.state.valid = next;
    const patch = {
      id: digest({ targetCertId: target.id, reason, add: addSet, subtract: subSet }),
      targetCertId: target.id,
      reason,
      add: clone(addSet),
      subtract: clone(subSet),
      revoked: false,
    };
    const cert = this.#commit({
      inputDigest: digest(patch),
      ops: [{ op: 'patch', add: clone(addSet), subtract: clone(subSet) }],
      cause: { type: 'correction', invalidates: target.id, reason, patchId: patch.id },
    });
    patch.certId = cert.id;
    this.patches.push(patch);
    return { patch, cert };
  }

  // Revoke the most recent patch, restoring the exact pre-patch state
  // (holes recover). The restoring cert must match the pre-patch coverage.
  revokePatch(patchId) {
    const patch = this.patches[this.patches.length - 1];
    if (!patch || patch.id !== patchId) {
      throw patchError('only the latest patch can be revoked', { patchId });
    }
    if (patch.revoked) {
      throw patchError('patch already revoked', { patchId });
    }
    const restored = union(
      difference(this.state.valid, patch.add),
      patch.subtract,
    );
    const prePatchCert = this.certs.find((c) => c.id === patch.targetCertId);
    this.state.valid = restored;
    const cert = this.#commit({
      inputDigest: digest({ revoke: patchId }),
      ops: [{ op: 'revoke', patchId }],
      cause: { type: 'revocation', revokes: patchId, restores: patch.targetCertId },
    });
    if (prePatchCert && digest(restored) !== digest(
      normalize(prePatchCert.output.valid),
    )) {
      throw patchError('revocation did not restore pre-patch coverage', { patchId });
    }
    patch.revoked = true;
    return { cert, restored: clone(restored) };
  }

  verify() {
    return verifyChain(this.certs);
  }

  toJSON() {
    return {
      state: this.state,
      rawLog: this.rawLog,
      certs: this.certs,
      patches: this.patches,
    };
  }

  static fromJSON(data) {
    const service = new AuditService();
    service.state = data.state;
    service.rawLog = data.rawLog;
    service.certs = data.certs;
    service.patches = data.patches;
    return service;
  }
}
