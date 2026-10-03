// Replayable mutation certificates. Every state mutation performed by the
// scheduler appends one certificate; replaying the certificate log from an
// empty state must reproduce the final schedule exactly.
import { createHash } from 'node:crypto';

// Canonical hash of the observable state: confirmed assignments plus the
// orphan set. Deterministic by construction (sorted keys, sorted entries).
export function hashState(confirmed, orphans) {
  const c = [...confirmed.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const o = [...orphans].sort();
  return createHash('sha256').update(JSON.stringify({ c, o })).digest('hex');
}

export function snapshotOf(state) {
  const orphans = new Set();
  for (const [id, st] of state.status) if (st === 'orphan') orphans.add(id);
  return { confirmed: new Map(state.slotOf), orphans };
}

export function emitCertificate(state, cert) {
  state.seq += 1;
  const { confirmed, orphans } = snapshotOf(state);
  state.certificates.push({ seq: state.seq, ...cert, hash: hashState(confirmed, orphans) });
}

// Replays a certificate log from the empty state, verifying the state hash
// after every step. Returns { valid, failedAt, confirmed, orphans }.
export function replay(certificates) {
  const confirmed = new Map();
  const orphans = new Set();
  for (const cert of certificates) {
    switch (cert.op) {
      case 'assign':
        confirmed.set(cert.instructionId, cert.slot);
        orphans.delete(cert.instructionId);
        break;
      case 'preempt':
      case 'rollback':
      case 'undo':
        confirmed.delete(cert.instructionId);
        break;
      case 'orphan':
        confirmed.delete(cert.instructionId);
        orphans.add(cert.instructionId);
        break;
      default:
        return { valid: false, failedAt: cert.seq, confirmed, orphans, reason: `unknown op ${cert.op}` };
    }
    if (hashState(confirmed, orphans) !== cert.hash) {
      return { valid: false, failedAt: cert.seq, confirmed, orphans, reason: 'hash mismatch' };
    }
  }
  return { valid: true, confirmed, orphans };
}
