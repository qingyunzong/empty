'use strict';

// Retry lifecycle: PENDING -> RUNNING -> (freeze committed) -> SUCCESS | FAILED.
// Cancellation may happen from PENDING or RUNNING.

function createRetry(txId, batchId) {
  return { txId, batchId, state: 'PENDING', freezeCommitted: false };
}

function begin(retry) {
  if (retry.state !== 'PENDING') {
    throw new Error(`retry ${retry.txId}@${retry.batchId}: cannot begin from ${retry.state}`);
  }
  retry.state = 'RUNNING';
}

function commitFreeze(retry) {
  if (retry.state !== 'RUNNING') {
    throw new Error(`retry ${retry.txId}@${retry.batchId}: cannot commit freeze from ${retry.state}`);
  }
  retry.freezeCommitted = true;
}

function succeed(retry) {
  // Never fake success: a freeze must have been committed first.
  if (retry.state !== 'RUNNING' || !retry.freezeCommitted) {
    throw new Error(`retry ${retry.txId}@${retry.batchId}: cannot succeed without committed freeze`);
  }
  retry.state = 'SUCCESS';
}

function fail(retry) {
  if (retry.state !== 'RUNNING') {
    throw new Error(`retry ${retry.txId}@${retry.batchId}: cannot fail from ${retry.state}`);
  }
  retry.freezeCommitted = false; // release tentative freeze
  retry.state = 'FAILED';
}

function cancel(retry) {
  if (retry.state === 'SUCCESS') {
    throw new Error(`retry ${retry.txId}@${retry.batchId}: cannot cancel a succeeded retry`);
  }
  retry.freezeCommitted = false;
  retry.state = 'CANCELLED';
}

// Crash point: state persisted as RUNNING but the freeze record was never
// committed. Recovery must roll such retries back to PENDING so they can be
// safely retried; it must never mark them SUCCESS.
function recover(state) {
  const recovered = [];
  for (const retry of Object.values(state.retries)) {
    if (retry.state === 'RUNNING' && !retry.freezeCommitted) {
      retry.state = 'PENDING';
      retry.recoveredFrom = 'RUNNING';
      recovered.push(retry);
    }
  }
  return recovered;
}

module.exports = { createRetry, begin, commitFreeze, succeed, fail, cancel, recover };
