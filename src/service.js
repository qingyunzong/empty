import { AuditError, E_INTERVAL, E_PATCH, E_UNKNOWN } from './errors.js';
import { digest } from './canon.js';
import {
  normalize, union, difference, intersect, containsPoint, gaps, validateInterval,
} from './intervals.js';
import { KINDS, GENESIS, emptyState, issueCert, verifyChain } from './cert.js';

const STATUS_PRIORITY = ['FROZEN', 'EXEMPT', 'VALID', 'PENDING'];

export class AuditService {
  constructor() {
    this.state = emptyState();
    this.certs = [];
    this.patches = new Map();
    this.patchCounter = 0;
  }

  // Unknown-source intervals are classified as PENDING, never rejected.
  resolveKind(kind) {
    if (kind === undefined || kind === null) return 'PENDING';
    const k = String(kind).toUpperCase();
    return KINDS.includes(k) ? k : 'PENDING';
  }

  requireKind(kind) {
    const k = String(kind ?? '').toUpperCase();
    if (!KINDS.includes(k)) {
      throw new AuditError(E_UNKNOWN, `unknown interval kind: ${kind}`);
    }
    return k;
  }

  importBatch(ops) {
    if (!Array.isArray(ops) || ops.length === 0) {
      throw new AuditError(E_INTERVAL, 'batch must be a non-empty array of operations');
    }
    const applied = [];
    for (const op of ops) {
      if (!op || op.op !== 'add') {
        throw new AuditError(E_UNKNOWN, `unknown operation: ${op && op.op}`);
      }
      const kind = this.resolveKind(op.kind);
      const intervals = normalize(op.intervals ?? []);
      if (intervals.length === 0) {
        throw new AuditError(E_INTERVAL, 'operation contains no intervals');
      }
      this.state[kind] = union(this.state[kind], intervals);
      applied.push({ op: 'add', kind, intervals });
    }
    return this.#commit('import', applied);
  }

  applyPatch({ patchId, targetCertId, reason, kind, remove = [], add = [] } = {}) {
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new AuditError(E_PATCH, 'patch requires an invalidation reason for the old certificate');
    }
    const kindKey = this.requireKind(kind);
    if (this.certs.length === 0) {
      throw new AuditError(E_PATCH, 'no certificate exists to patch');
    }
    const latest = this.certs[this.certs.length - 1];
    const target = targetCertId ?? latest.id;
    if (target !== latest.id) {
      throw new AuditError(E_PATCH, `patch target ${target} is not the latest certificate ${latest.id}`);
    }
    const id = patchId ?? `patch-${(this.patchCounter += 1)}`;
    if (this.patches.has(id)) {
      throw new AuditError(E_PATCH, `duplicate patch id ${id}`);
    }
    const removed = normalize(remove);
    const added = normalize(add);
    if (removed.length === 0 && added.length === 0) {
      throw new AuditError(E_PATCH, 'patch must remove or add at least one interval');
    }
    this.state[kindKey] = union(difference(this.state[kindKey], removed), added);
    const cert = this.#commit('patch', [{ op: 'patch', kind: kindKey, removed, added }], {
      supersedes: latest.id,
      invalidationReason: reason,
      patchId: id,
    });
    this.patches.set(id, { patchId: id, kind: kindKey, removed, added, certId: cert.id, reverted: false });
    return cert;
  }

  revertPatch(patchId) {
    const rec = this.patches.get(patchId);
    if (!rec) {
      throw new AuditError(E_PATCH, `unknown patch: ${patchId}`);
    }
    if (rec.reverted) {
      throw new AuditError(E_PATCH, `patch ${patchId} already reverted`);
    }
    this.state[rec.kind] = union(difference(this.state[rec.kind], rec.added), rec.removed);
    rec.reverted = true;
    return this.#commit('revert', [{ op: 'revert', kind: rec.kind, removed: rec.added, added: rec.removed }], {
      reverts: patchId,
      patchId,
    });
  }

  queryPoint(point) {
    if (!Number.isInteger(point)) {
      throw new AuditError(E_INTERVAL, `point must be an integer, got ${point}`);
    }
    const hits = KINDS.filter((k) => containsPoint(this.state[k], point));
    const status = STATUS_PRIORITY.find((k) => hits.includes(k)) ?? 'UNCOVERED';
    return { point, kinds: hits, status };
  }

  report(lo, hi) {
    validateInterval({ start: lo, end: hi });
    const domain = [{ start: lo, end: hi }];
    const all = KINDS.reduce((acc, k) => union(acc, this.state[k]), []);
    const overlaps = [];
    for (let i = 0; i < KINDS.length; i += 1) {
      for (let j = i + 1; j < KINDS.length; j += 1) {
        const ov = intersect(intersect(this.state[KINDS[i]], this.state[KINDS[j]]), domain);
        if (ov.length > 0) overlaps.push({ kinds: [KINDS[i], KINDS[j]], intervals: ov });
      }
    }
    return {
      domain: { start: lo, end: hi },
      gaps: gaps(all, lo, hi),
      overlaps,
      pending: intersect(this.state.PENDING, domain),
    };
  }

  getState(kind) {
    if (kind === undefined) return structuredClone(this.state);
    return structuredClone(this.state[this.requireKind(kind)]);
  }

  verify() {
    return verifyChain(this.certs);
  }

  exportCerts() {
    return structuredClone(this.certs);
  }

  #commit(type, ops, extra = {}) {
    const seq = this.certs.length + 1;
    const prevHash = this.certs.length ? this.certs[this.certs.length - 1].hash : GENESIS;
    const cert = issueCert({
      seq,
      prevHash,
      type,
      inputDigest: digest(ops),
      ops,
      state: this.state,
      extra,
    });
    this.certs.push(cert);
    return cert;
  }

  toJSON() {
    return {
      state: this.state,
      certs: this.certs,
      patches: [...this.patches.values()],
      patchCounter: this.patchCounter,
    };
  }

  static fromJSON(data) {
    const svc = new AuditService();
    if (data && typeof data === 'object') {
      svc.state = { ...emptyState(), ...(data.state ?? {}) };
      svc.certs = Array.isArray(data.certs) ? data.certs : [];
      svc.patchCounter = data.patchCounter ?? 0;
      for (const p of data.patches ?? []) svc.patches.set(p.patchId, p);
    }
    return svc;
  }
}
