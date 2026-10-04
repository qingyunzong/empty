'use strict';

const crypto = require('crypto');
const { canonicalize } = require('./canonical');
const { FrameError } = require('./errors');

const KINDS = new Set(['PACK', 'REWORK', 'SCRAP', 'CORRECT']);

function eventId(e) {
  return `${e.batch}|${e.item}|${e.seq}|${e.kind}`;
}

function signingPayload(e) {
  return {
    batch: e.batch,
    item: e.item,
    seq: e.seq,
    lamport: e.lamport,
    kind: e.kind,
    ref: e.ref ?? null,
    qty: e.qty ?? null,
    reason: e.reason ?? null,
  };
}

function signEvent(fields) {
  return crypto.createHash('sha256').update(canonicalize(signingPayload(fields)), 'utf8').digest('hex');
}

function isNonNegInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

// Validates a parsed JSON object and returns a normalized event.
// Throws FrameError (exit 2) on any schema or signature problem.
function validateEvent(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new FrameError('event must be a JSON object');
  }
  const { batch, item, seq, lamport, kind, ref, qty, reason, sig } = obj;
  if (typeof batch !== 'string' || batch.length === 0) throw new FrameError('event.batch must be a non-empty string');
  if (typeof item !== 'string' || item.length === 0) throw new FrameError('event.item must be a non-empty string');
  if (!isNonNegInt(seq)) throw new FrameError('event.seq must be a non-negative integer');
  if (!isNonNegInt(lamport)) throw new FrameError('event.lamport must be a non-negative integer');
  if (!KINDS.has(kind)) throw new FrameError(`event.kind must be one of ${[...KINDS].join(',')}`);
  if (ref !== null && ref !== undefined && typeof ref !== 'string') throw new FrameError('event.ref must be a string or null');
  if (qty !== null && qty !== undefined && !isNonNegInt(qty)) throw new FrameError('event.qty must be a non-negative integer');
  if (reason !== null && reason !== undefined && typeof reason !== 'string') throw new FrameError('event.reason must be a string or null');

  if (kind === 'CORRECT') {
    if (typeof ref !== 'string' || ref.length === 0) throw new FrameError('CORRECT event requires a ref');
    if (!isNonNegInt(qty)) throw new FrameError('CORRECT event requires qty');
    if (typeof reason !== 'string' || reason.length === 0) throw new FrameError('CORRECT event requires a reason');
  } else {
    if (ref !== null && ref !== undefined) throw new FrameError(`${kind} event must not carry a ref`);
    if (!isNonNegInt(qty)) throw new FrameError(`${kind} event requires qty`);
  }

  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) {
    throw new FrameError('event.sig must be a 64-char lowercase hex sha256');
  }
  const expected = signEvent({ batch, item, seq, lamport, kind, ref: ref ?? null, qty: qty ?? null, reason: reason ?? null });
  if (sig !== expected) {
    throw new FrameError(`event signature mismatch for ${batch}|${item}|${seq}|${kind}`);
  }

  return {
    batch, item, seq, lamport, kind,
    ref: ref ?? null,
    qty: qty ?? null,
    reason: reason ?? null,
    sig,
  };
}

module.exports = { KINDS, eventId, signingPayload, signEvent, validateEvent };
