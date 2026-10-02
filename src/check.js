import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { parseLog, verifyEvents, rootOf } from './log.js';
import { complementRanges } from './patch.js';
import { recoverState } from './recover.js';
import { AuditError, EXIT } from './errors.js';

function loadCert(path) {
  let cert;
  try {
    cert = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new AuditError(EXIT.CERT_MISMATCH, `${path}: certificate unreadable: ${err.message}`);
  }
  if (cert === null || typeof cert !== 'object' || Array.isArray(cert)) {
    throw new AuditError(EXIT.CERT_MISMATCH, `${path}: certificate must be an object`);
  }
  return cert;
}

function validateCertShape(cert, n) {
  const bad = (msg) => new AuditError(EXIT.CERT_MISMATCH, `certificate invalid: ${msg}`);
  if (cert.version !== 1) throw bad('unsupported version');
  if (!Array.isArray(cert.changedSeqs) || !Array.isArray(cert.unchangedRanges) || !Array.isArray(cert.changes)) {
    throw bad('missing changedSeqs/unchangedRanges/changes');
  }
  const seqs = cert.changedSeqs;
  for (let i = 0; i < seqs.length; i++) {
    if (!Number.isInteger(seqs[i]) || seqs[i] < 1 || seqs[i] > n) throw bad(`changedSeqs[${i}] out of range`);
    if (i > 0 && seqs[i] <= seqs[i - 1]) throw bad('changedSeqs not strictly ascending');
  }
  if (!isDeepStrictEqual(cert.unchangedRanges, complementRanges(seqs, n))) {
    throw bad('unchangedRanges does not match complement of changedSeqs');
  }
  const changeSeqs = cert.changes.map((c) => c && c.seq);
  if (!isDeepStrictEqual(changeSeqs, seqs)) throw bad('changes do not align with changedSeqs');
}

// Core check, pure on parsed inputs. Throws AuditError locating the first failing seq.
export function checkEvents(oldEvents, newEvents, cert) {
  compareSeqs(oldEvents, newEvents);
  const n = oldEvents.length;

  validateCertShape(cert, n);
  if (cert.oldRoot !== rootOf(oldEvents)) {
    throw new AuditError(EXIT.CERT_MISMATCH, 'certificate oldRoot does not match old log');
  }
  if (cert.newRoot !== rootOf(newEvents)) {
    throw new AuditError(EXIT.CERT_MISMATCH, 'certificate newRoot does not match new log');
  }

  const changeBySeq = new Map(cert.changes.map((c) => [c.seq, c]));
  for (let i = 0; i < n; i++) {
    const seq = i + 1;
    const before = oldEvents[i];
    const after = newEvents[i];
    const change = changeBySeq.get(seq);
    if (change) {
      if (change.beforeHash !== before.hash) {
        throw new AuditError(EXIT.CERT_MISMATCH, `cert mismatch at seq ${seq}: beforeHash does not match old log`, seq);
      }
      if (change.afterHash !== after.hash) {
        throw new AuditError(EXIT.CERT_MISMATCH, `cert mismatch at seq ${seq}: afterHash does not match new log`, seq);
      }
      if (change.op === 'void') {
        if (after.body?.voided !== true || after.body?.reason !== change.reason) {
          throw new AuditError(EXIT.CERT_MISMATCH, `cert mismatch at seq ${seq}: void tombstone missing or reason differs`, seq);
        }
      } else if (change.op === 'replaceBody') {
        for (const [k, v] of Object.entries(change.fields ?? {})) {
          if (!isDeepStrictEqual(after.body?.[k], v)) {
            throw new AuditError(EXIT.CERT_MISMATCH, `cert mismatch at seq ${seq}: field ${JSON.stringify(k)} does not match certified replaceBody`, seq);
          }
        }
      } else {
        throw new AuditError(EXIT.CERT_MISMATCH, `cert mismatch at seq ${seq}: unknown op ${JSON.stringify(change.op)}`, seq);
      }
    } else if (!isDeepStrictEqual(before.body, after.body)) {
      throw new AuditError(EXIT.CERT_MISMATCH, `cert mismatch at seq ${seq}: body changed but certified as unchanged`, seq);
    }
  }
  return { changedSeqs: cert.changedSeqs, oldRoot: cert.oldRoot, newRoot: cert.newRoot };
}

function compareSeqs(oldEvents, newEvents) {
  if (newEvents.length !== oldEvents.length) {
    throw new AuditError(EXIT.SEQ_TAMPER, `unauthorized seq change: old has ${oldEvents.length} events, new has ${newEvents.length}`);
  }
  for (let i = 0; i < oldEvents.length; i++) {
    if (newEvents[i].seq !== oldEvents[i].seq) {
      throw new AuditError(EXIT.SEQ_TAMPER, `unauthorized seq change at position ${i + 1}: ${oldEvents[i].seq} -> ${newEvents[i].seq}`, oldEvents[i].seq);
    }
  }
}

// File-level check with crash-state detection: refuses to silently mix partial output.
// Order: crash state -> seq-set equality (exit 10) -> chain integrity (exit 9) -> cert (exit 11).
export function checkFiles(oldPath, newPath, certPath) {
  const state = recoverState(newPath, certPath);
  if (state.state !== 'new') {
    throw new AuditError(EXIT.CRASH_STATE, state.message);
  }
  const oldEvents = parseLog(readFileSync(oldPath, 'utf8'), oldPath);
  const newEvents = parseLog(readFileSync(newPath, 'utf8'), newPath);
  compareSeqs(oldEvents, newEvents);
  verifyEvents(oldEvents, oldPath);
  verifyEvents(newEvents, newPath);
  const cert = loadCert(certPath);
  return checkEvents(oldEvents, newEvents, cert);
}
