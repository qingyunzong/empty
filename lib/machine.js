'use strict';

const { canonical, hashCanonical } = require('./canonical');

const GENESIS = '0'.repeat(64);

class MachineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MachineError';
    this.code = code;
  }
}

// Deterministic hash of a transaction event; revocations reference it.
function txHashOf(txEvent) {
  return hashCanonical({
    type: 'tx',
    id: txEvent.id,
    logicalClock: txEvent.logicalClock,
    amount: txEvent.amount,
  });
}

function createState() {
  return {
    balance: 0,
    txs: Object.create(null),     // txHash -> { amount, revoked }
    revokes: Object.create(null), // revoke event id -> { txHash, amount, unrevoked }
  };
}

function remainingOf(tx) {
  return tx.amount - tx.revoked;
}

function totalRevocable(state) {
  let sum = 0;
  for (const h of Object.keys(state.txs)) sum += remainingOf(state.txs[h]);
  return sum;
}

// Domain snapshot used for stateHash and for the persisted final state.
function snapshot(state) {
  const txs = {};
  for (const h of Object.keys(state.txs).sort()) {
    const tx = state.txs[h];
    txs[h] = { amount: tx.amount, revoked: tx.revoked, remaining: remainingOf(tx) };
  }
  const revokes = {};
  for (const id of Object.keys(state.revokes).sort()) {
    const r = state.revokes[id];
    revokes[id] = { txHash: r.txHash, amount: r.amount, unrevoked: r.unrevoked };
  }
  return {
    balance: state.balance,
    revocable: totalRevocable(state),
    txs,
    revokes,
  };
}

function requireInt(value, field, eventId) {
  if (!Number.isSafeInteger(value)) {
    throw new MachineError('E_SCHEMA', `event ${eventId}: field ${field} must be a safe integer`);
  }
}

function validateEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new MachineError('E_SCHEMA', 'event must be an object');
  }
  if (typeof event.id !== 'string' || event.id.length === 0) {
    throw new MachineError('E_SCHEMA', 'event id must be a non-empty string');
  }
  requireInt(event.logicalClock, 'logicalClock', event.id);
  if (event.type !== 'tx' && event.type !== 'revoke' && event.type !== 'unrevoke') {
    throw new MachineError('E_SCHEMA', `event ${event.id}: unknown type ${JSON.stringify(event.type)}`);
  }
  requireInt(event.amount, 'amount', event.id);
  if (event.amount <= 0) {
    throw new MachineError('E_SCHEMA', `event ${event.id}: amount must be positive`);
  }
  if (event.type === 'revoke' && (typeof event.txHash !== 'string' || !/^[0-9a-f]{64}$/.test(event.txHash))) {
    throw new MachineError('E_SCHEMA', `event ${event.id}: txHash must be a 64-char hex string`);
  }
  if (event.type === 'unrevoke' && (typeof event.revokeId !== 'string' || event.revokeId.length === 0)) {
    throw new MachineError('E_SCHEMA', `event ${event.id}: revokeId must be a non-empty string`);
  }
}

function applyEvent(state, event) {
  switch (event.type) {
    case 'tx': {
      const h = txHashOf(event);
      if (state.txs[h]) {
        throw new MachineError('E_DUP_TX', `event ${event.id}: transaction hash collision`);
      }
      state.txs[h] = { amount: event.amount, revoked: 0 };
      state.balance += event.amount;
      return;
    }
    case 'revoke': {
      const tx = state.txs[event.txHash];
      if (!tx) {
        throw new MachineError('E_REF', `event ${event.id}: unknown txHash ${event.txHash}`);
      }
      if (event.amount > remainingOf(tx)) {
        throw new MachineError(
          'E_AMOUNT',
          `event ${event.id}: revoke amount ${event.amount} exceeds remaining revocable ${remainingOf(tx)}`
        );
      }
      tx.revoked += event.amount;
      state.balance -= event.amount;
      state.revokes[event.id] = { txHash: event.txHash, amount: event.amount, unrevoked: 0 };
      return;
    }
    case 'unrevoke': {
      const r = state.revokes[event.revokeId];
      if (!r) {
        throw new MachineError('E_REF', `event ${event.id}: unknown revokeId ${event.revokeId}`);
      }
      const tx = state.txs[r.txHash];
      const restorable = r.amount - r.unrevoked;
      if (event.amount > restorable) {
        throw new MachineError(
          'E_AMOUNT',
          `event ${event.id}: unrevoke amount ${event.amount} exceeds restorable ${restorable}`
        );
      }
      if (remainingOf(tx) + event.amount > tx.amount) {
        throw new MachineError(
          'E_AMOUNT',
          `event ${event.id}: unrevoke would exceed original tx cap ${tx.amount}`
        );
      }
      r.unrevoked += event.amount;
      tx.revoked -= event.amount;
      state.balance += event.amount;
      return;
    }
    /* istanbul ignore next */
    default:
      throw new MachineError('E_SCHEMA', `event ${event.id}: unknown type`);
  }
}

function compareEvents(a, b) {
  if (a.logicalClock !== b.logicalClock) return a.logicalClock - b.logicalClock;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Dedupe by event id (idempotent re-submission), sort by (logicalClock, id),
// then replay, emitting one certificate per applied event.
function run(events) {
  if (!Array.isArray(events)) {
    throw new MachineError('E_SCHEMA', 'events must be an array');
  }
  const seen = new Set();
  const unique = [];
  for (const event of events) {
    validateEvent(event);
    if (seen.has(event.id)) continue; // idempotent: same id applied once
    seen.add(event.id);
    unique.push(event);
  }
  unique.sort(compareEvents);

  const state = createState();
  const certs = [];
  let prevHash = GENESIS;
  for (const event of unique) {
    applyEvent(state, event);
    const stateHash = hashCanonical(snapshot(state));
    const cert = { seq: certs.length, eventId: event.id, prevHash, stateHash };
    cert.hash = hashCanonical(cert);
    certs.push(cert);
    prevHash = cert.hash;
  }
  return {
    events: unique,
    certs,
    state: snapshot(state),
    head: prevHash,
  };
}

function certsEqual(a, b) {
  return (
    a.seq === b.seq &&
    a.eventId === b.eventId &&
    a.prevHash === b.prevHash &&
    a.stateHash === b.stateHash &&
    a.hash === b.hash
  );
}

// Recompute the chain from the persisted events and check every link.
// Any tampering (events, certs, state, head) raises E_CERT.
function verify(bundle) {
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new MachineError('E_CERT', 'state file must be a JSON object');
  }
  if (!Array.isArray(bundle.events) || !Array.isArray(bundle.certs)) {
    throw new MachineError('E_CERT', 'state file missing events or certs');
  }
  const recomputed = run(bundle.events);

  if (recomputed.certs.length !== bundle.certs.length) {
    throw new MachineError(
      'E_CERT',
      `cert count mismatch: expected ${recomputed.certs.length}, got ${bundle.certs.length}`
    );
  }
  for (let i = 0; i < recomputed.certs.length; i++) {
    if (!certsEqual(recomputed.certs[i], bundle.certs[i])) {
      throw new MachineError('E_CERT', `cert ${i} (event ${bundle.certs[i] && bundle.certs[i].eventId}) does not match recomputed chain`);
    }
  }
  if (bundle.head !== recomputed.head) {
    throw new MachineError('E_CERT', 'head hash mismatch');
  }
  if (canonical(bundle.state) !== canonical(recomputed.state)) {
    throw new MachineError('E_CERT', 'final state mismatch');
  }
  return { ok: true, steps: recomputed.certs.length, head: recomputed.head, state: recomputed.state };
}

module.exports = {
  GENESIS,
  MachineError,
  txHashOf,
  createState,
  snapshot,
  run,
  verify,
};
