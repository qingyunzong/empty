import { canonical, digest } from './canon.js';
import { AuditError, E_CERT } from './errors.js';
import { union, difference } from './intervals.js';

export const KINDS = ['VALID', 'FROZEN', 'EXEMPT', 'PENDING'];
export const GENESIS = 'GENESIS';

export function emptyState() {
  return { VALID: [], FROZEN: [], EXEMPT: [], PENDING: [] };
}

export function stateDigest(state) {
  return digest(state);
}

export function issueCert({ seq, prevHash, type, inputDigest, ops, state, extra = {} }) {
  const id = `cert-${String(seq).padStart(4, '0')}`;
  const body = {
    id,
    seq,
    prevHash,
    type,
    inputDigest,
    ops,
    stateHash: stateDigest(state),
    ...extra,
  };
  return { ...body, hash: digest(body) };
}

function applyOp(state, op, certId) {
  if (!op || typeof op !== 'object' || !KINDS.includes(op.kind)) {
    throw new AuditError(E_CERT, `certificate ${certId}: malformed operation`);
  }
  if (op.op === 'add') {
    state[op.kind] = union(state[op.kind], op.intervals);
  } else if (op.op === 'patch' || op.op === 'revert') {
    state[op.kind] = union(difference(state[op.kind], op.removed), op.added);
  } else {
    throw new AuditError(E_CERT, `certificate ${certId}: unknown op ${op.op}`);
  }
}

export function verifyChain(certs) {
  if (!Array.isArray(certs) || certs.length === 0) {
    throw new AuditError(E_CERT, 'certificate chain is empty');
  }
  const state = emptyState();
  const byId = new Map();
  let prevHash = GENESIS;

  for (const cert of certs) {
    if (!cert || typeof cert !== 'object' || typeof cert.hash !== 'string') {
      throw new AuditError(E_CERT, 'malformed certificate');
    }
    const { hash, ...body } = cert;
    if (digest(body) !== hash) {
      throw new AuditError(E_CERT, `certificate ${cert.id}: hash mismatch, tampering detected`);
    }
    if (cert.prevHash !== prevHash) {
      throw new AuditError(E_CERT, `certificate ${cert.id}: chain link broken`);
    }
    if (cert.seq !== byId.size + 1) {
      throw new AuditError(E_CERT, `certificate ${cert.id}: sequence mismatch`);
    }
    if (digest(cert.ops) !== cert.inputDigest) {
      throw new AuditError(E_CERT, `certificate ${cert.id}: input digest mismatch`);
    }

    const preHash = stateDigest(state);

    if (cert.type === 'patch') {
      if (typeof cert.invalidationReason !== 'string' || cert.invalidationReason.length === 0) {
        throw new AuditError(E_CERT, `certificate ${cert.id}: patch missing invalidation reason`);
      }
      const old = byId.get(cert.supersedes);
      if (!old) {
        throw new AuditError(E_CERT, `certificate ${cert.id}: supersedes unknown certificate ${cert.supersedes}`);
      }
      if (old.stateHash !== preHash) {
        throw new AuditError(E_CERT, `certificate ${cert.id}: does not cover state of ${old.id}`);
      }
    }
    if (cert.type === 'revert') {
      const target = [...byId.values()].find((c) => c.patchId === cert.reverts);
      if (!target) {
        throw new AuditError(E_CERT, `certificate ${cert.id}: reverts unknown patch ${cert.reverts}`);
      }
    }

    for (const op of cert.ops) applyOp(state, op, cert.id);

    if (stateDigest(state) !== cert.stateHash) {
      throw new AuditError(E_CERT, `certificate ${cert.id}: output interval hash mismatch`);
    }

    byId.set(cert.id, cert);
    prevHash = hash;
  }

  return { ok: true, certs: certs.length, stateHash: stateDigest(state) };
}
