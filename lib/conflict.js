'use strict';

const { ERR, guard, applyEvent } = require('./model');
const { cert } = require('./cert');

// Conflict certificate: proves why a concurrently-validated event was rejected
// at apply time. Carries the losing event, the contested sale, and the hash of
// the state it lost against, so the conflict is auditable offline.
function conflictCertificate(state, event, code, message) {
  return {
    type: 'conflict-certificate',
    code,
    message,
    event,
    baseSeq: event.baseSeq === undefined ? null : event.baseSeq,
    stateSeq: state.seq,
    stateHash: cert(state).overall,
    sale: event.ref ? (state.sales[event.ref] || null) : null,
  };
}

// Optimistic concurrency apply. If the caller supplies baseSeq (the log length
// it validated against) and the log has since moved, the event conflicts and is
// rejected without any state change. Otherwise the event is re-guarded against
// current state; an over-refund caused by a concurrent refund yields a conflict
// certificate. Never auto-splits amounts.
function applyConcurrent(state, event) {
  if (event.baseSeq !== undefined && event.baseSeq !== state.seq) {
    const message = `stale baseSeq ${event.baseSeq}, current seq ${state.seq}`;
    return { ok: false, code: ERR.CONFLICT, message, certificate: conflictCertificate(state, event, ERR.CONFLICT, message) };
  }
  const g = guard(state, event);
  if (!g.ok) {
    const res = { ok: false, code: g.code, message: g.message };
    if (event.type === 'refund' && g.code === ERR.DUPLICATE_REFUND) {
      res.certificate = conflictCertificate(state, event, g.code, g.message);
    }
    return res;
  }
  applyEvent(state, event);
  return { ok: true, seq: state.seq };
}

module.exports = { applyConcurrent, conflictCertificate };
