import crypto from 'node:crypto';
import { LogError, E_REVISION, E_NO_CORRECTION } from './errors.js';

export function hashRecord(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Issues a verifiable certificate for the currently active correction of
// targetSeq. Binds the hash of the original event record, the hash of the
// active correction record and the correction's sequence number.
export function issueCertificate(decoder, targetSeq) {
  const event = decoder.events.get(targetSeq);
  if (!event) {
    throw new LogError(E_REVISION, `no event with seq ${targetSeq}`);
  }
  const list = decoder.corrections.get(targetSeq);
  if (!list || list.length === 0) {
    throw new LogError(E_NO_CORRECTION, `event ${targetSeq} has no correction`);
  }
  const active = list[list.length - 1];
  return {
    version: 1,
    kind: 'evlog-correction',
    targetSeq,
    originalHash: hashRecord(event.raw),
    correctionHash: hashRecord(active.raw),
    activeSeq: active.seq,
  };
}

// Re-derives every value from the log itself; the certificate is only valid
// if all hashes match and activeSeq is the latest correction for targetSeq.
export function verifyCertificate(decoder, cert) {
  if (!cert || cert.version !== 1 || cert.kind !== 'evlog-correction') return false;
  if (!Number.isInteger(cert.targetSeq) || !Number.isInteger(cert.activeSeq)) return false;
  const event = decoder.events.get(cert.targetSeq);
  if (!event) return false;
  if (hashRecord(event.raw) !== cert.originalHash) return false;
  const list = decoder.corrections.get(cert.targetSeq) ?? [];
  const active = list[list.length - 1];
  if (!active || active.seq !== cert.activeSeq) return false;
  if (active.refSeq !== cert.targetSeq) return false;
  return hashRecord(active.raw) === cert.correctionHash;
}
