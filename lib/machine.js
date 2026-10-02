'use strict';

const crypto = require('node:crypto');
const { canonicalize } = require('./canonical');

const GENESIS_HASH = crypto
  .createHash('sha256')
  .update('reversal-chain:genesis:v1')
  .digest('hex');

class MachineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MachineError';
    this.code = code;
  }
}

function sha256hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Hash of an event's canonical JSON — this is the "transaction hash" that
// reversals reference, and the "reversal hash" that reinstates reference.
function eventHash(event) {
  return sha256hex(canonicalize(event));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isValidAmount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isValidClock(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function validateEvent(raw) {
  if (!isPlainObject(raw)) {
    throw new MachineError('E_BAD_EVENT', 'event is not an object');
  }
  const e = raw;
  if (!isNonEmptyString(e.eventId)) {
    throw new MachineError('E_BAD_EVENT', 'eventId must be a non-empty string');
  }
  if (!isValidClock(e.logicalClock)) {
    throw new MachineError('E_BAD_EVENT', 'logicalClock must be a non-negative integer');
  }
  if (!isValidAmount(e.amount)) {
    throw new MachineError('E_BAD_EVENT', 'amount must be a positive finite number');
  }
  switch (e.type) {
    case 'tx':
      if (!isNonEmptyString(e.txId)) {
        throw new MachineError('E_BAD_EVENT', 'tx requires txId');
      }
      return {
        type: 'tx',
        eventId: e.eventId,
        logicalClock: e.logicalClock,
        txId: e.txId,
        amount: e.amount,
      };
    case 'reversal':
      if (!isNonEmptyString(e.txHash)) {
        throw new MachineError('E_BAD_EVENT', 'reversal requires txHash');
      }
      return {
        type: 'reversal',
        eventId: e.eventId,
        logicalClock: e.logicalClock,
        txHash: e.txHash,
        amount: e.amount,
      };
    case 'reinstate':
      if (!isNonEmptyString(e.reversalHash)) {
        throw new MachineError('E_BAD_EVENT', 'reinstate requires reversalHash');
      }
      return {
        type: 'reinstate',
        eventId: e.eventId,
        logicalClock: e.logicalClock,
        reversalHash: e.reversalHash,
        amount: e.amount,
      };
    default:
      throw new MachineError('E_BAD_EVENT', 'unknown event type: ' + String(e.type));
  }
}

function createState() {
  return { balance: 0, reversals: {}, txs: {} };
}

function stateHash(state) {
  return sha256hex(canonicalize(state));
}

// Remaining reversible amount for a transaction: original minus net reversed.
function remainingReversible(tx) {
  return tx.amount - tx.reversed + tx.reinstated;
}

function applyEvent(state, event) {
  const hash = eventHash(event);
  switch (event.type) {
    case 'tx': {
      if (state.txs[hash]) {
        throw new MachineError('E_DUP_TX', 'duplicate transaction hash ' + hash);
      }
      state.txs[hash] = {
        amount: event.amount,
        reinstated: 0,
        reversed: 0,
        txId: event.txId,
      };
      state.balance += event.amount;
      return hash;
    }
    case 'reversal': {
      const tx = state.txs[event.txHash];
      if (!tx) {
        throw new MachineError('E_UNKNOWN_TX', 'unknown txHash ' + event.txHash);
      }
      const remaining = remainingReversible(tx);
      if (event.amount > remaining) {
        throw new MachineError(
          'E_AMOUNT',
          'reversal ' + event.amount + ' exceeds remaining reversible ' + remaining
        );
      }
      tx.reversed += event.amount;
      state.balance -= event.amount;
      state.reversals[hash] = {
        amount: event.amount,
        reinstated: 0,
        txHash: event.txHash,
      };
      return hash;
    }
    case 'reinstate': {
      const rev = state.reversals[event.reversalHash];
      if (!rev) {
        throw new MachineError(
          'E_UNKNOWN_REVERSAL',
          'unknown reversalHash ' + event.reversalHash
        );
      }
      // Cannot restore more than this reversal actually reversed, which also
      // guarantees the transaction never exceeds its original amount.
      const remaining = rev.amount - rev.reinstated;
      if (event.amount > remaining) {
        throw new MachineError(
          'E_AMOUNT',
          'reinstate ' + event.amount + ' exceeds remaining reinstatable ' + remaining
        );
      }
      rev.reinstated += event.amount;
      state.txs[rev.txHash].reinstated += event.amount;
      state.balance += event.amount;
      return hash;
    }
    default:
      throw new MachineError('E_BAD_EVENT', 'unknown event type: ' + String(event.type));
  }
}

// Sort by (logicalClock, eventId), then drop repeated eventIds (idempotent).
function orderEvents(events) {
  const sorted = [...events].sort((a, b) => {
    if (a.logicalClock !== b.logicalClock) return a.logicalClock - b.logicalClock;
    if (a.eventId < b.eventId) return -1;
    if (a.eventId > b.eventId) return 1;
    return 0;
  });
  const seen = new Set();
  const ordered = [];
  const duplicates = [];
  for (const e of sorted) {
    if (seen.has(e.eventId)) {
      duplicates.push(e.eventId);
      continue;
    }
    seen.add(e.eventId);
    ordered.push(e);
  }
  return { ordered, duplicates };
}

// Replay events, producing one certificate per applied event.
function runChain(rawEvents) {
  const events = rawEvents.map(validateEvent);
  const { ordered, duplicates } = orderEvents(events);
  const state = createState();
  const certs = [];
  let prevHash = GENESIS_HASH;
  for (const event of ordered) {
    const eHash = applyEvent(state, event);
    const sHash = stateHash(state);
    const core = {
      eventHash: eHash,
      eventId: event.eventId,
      prevHash,
      seq: certs.length,
      stateHash: sHash,
    };
    const certHash = sha256hex(canonicalize(core));
    certs.push({ ...core, certHash });
    prevHash = certHash;
  }
  return { state, certs, duplicates, ordered };
}

function reversibleRanges(state) {
  const out = {};
  for (const hash of Object.keys(state.txs).sort()) {
    out[hash] = [0, remainingReversible(state.txs[hash])];
  }
  return out;
}

function buildSnapshot(rawEvents) {
  const { state, certs, duplicates, ordered } = runChain(rawEvents);
  return {
    version: 1,
    events: ordered,
    duplicates,
    certs,
    final: {
      balance: state.balance,
      reversible: reversibleRanges(state),
      stateHash: stateHash(state),
    },
  };
}

function certsEqual(a, b) {
  return canonicalize(a) === canonicalize(b);
}

// Re-execute the event log inside a snapshot and check every link of the
// certificate chain plus the recorded final state. Any drift -> E_CERT.
function verifySnapshot(snapshot) {
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.events)) {
    throw new MachineError('E_CERT', 'snapshot malformed');
  }
  let replay;
  try {
    replay = runChain(snapshot.events);
  } catch (err) {
    throw new MachineError('E_CERT', 'event log no longer valid: ' + err.message);
  }
  const storedCerts = snapshot.certs;
  if (!Array.isArray(storedCerts) || storedCerts.length !== replay.certs.length) {
    throw new MachineError('E_CERT', 'certificate chain length mismatch');
  }
  for (let i = 0; i < storedCerts.length; i++) {
    if (!certsEqual(storedCerts[i], replay.certs[i])) {
      throw new MachineError('E_CERT', 'certificate mismatch at seq ' + i);
    }
  }
  const expectedFinal = {
    balance: replay.state.balance,
    reversible: reversibleRanges(replay.state),
    stateHash: stateHash(replay.state),
  };
  if (!isPlainObject(snapshot.final) || canonicalize(snapshot.final) !== canonicalize(expectedFinal)) {
    throw new MachineError('E_CERT', 'final state mismatch');
  }
  return {
    ok: true,
    certsChecked: storedCerts.length,
    final: expectedFinal,
  };
}

module.exports = {
  GENESIS_HASH,
  MachineError,
  applyEvent,
  buildSnapshot,
  canonicalize,
  createState,
  eventHash,
  orderEvents,
  remainingReversible,
  reversibleRanges,
  runChain,
  sha256hex,
  stateHash,
  validateEvent,
  verifySnapshot,
};
