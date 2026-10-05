'use strict';
const { randomUUID } = require('node:crypto');
const { validation, state: stateErr } = require('./errors.js');
const { validateBin, validateItem, validateDelta, validateSessionId, validateNodeId } = require('./validate.js');
const { keyOf } = require('./core.js');

function begin(store, { session, node }) {
  validateSessionId(session);
  if (!store.exists()) {
    if (!node) throw stateErr('NOT_INITIALIZED', 'data dir not initialized; pass --node to create it');
    validateNodeId(node);
    store.init(node);
  }
  if (store.loadSession(session)) {
    throw stateErr('SESSION_EXISTS', `session ${session} already exists`);
  }
  const state = store.loadState();
  const sess = { id: session, node: state.nodeId, status: 'open', ops: [], created: new Date().toISOString() };
  store.saveSession(sess);
  return sess;
}

function loadOpenSession(store, sessionId) {
  validateSessionId(sessionId);
  store.requireInit();
  const sess = store.loadSession(sessionId);
  if (!sess) {
    const state = store.loadState();
    if (state.closedSessions.includes(sessionId)) {
      throw stateErr('CLOSED', `session ${sessionId} is closed`);
    }
    throw stateErr('SESSION_NOT_FOUND', `session ${sessionId} not found`);
  }
  if (sess.status !== 'open') throw stateErr('CLOSED', `session ${sessionId} is closed`);
  return sess;
}

// Projected quantity for bin+item: committed ledger plus this session's pending ops.
function projectedQty(state, sess, bin, item) {
  let q = state.inventory[keyOf(bin, item)] || 0;
  for (const op of sess.ops) {
    if (op.bin === bin && op.item === item) q += op.delta;
  }
  return q;
}

// Change capture for one bin+item. Durability order:
//   1. append to scan.log        (crash before -> event lost, operator rescans)
//   2. rewrite session tmp+rename(crash before rename -> tmp discarded, replayed from cursor)
//   3. advance cursor
function capture(store, { session, bin, item, delta, type }) {
  const sess = loadOpenSession(store, session);
  validateBin(bin);
  validateItem(item);
  validateDelta(delta);
  if (type === 'scan' && delta < 0) {
    throw validation('INVALID_QTY', 'scan quantity must be positive; use adjust for corrections');
  }
  const state = store.loadState();
  if (projectedQty(state, sess, bin, item) + delta < 0) {
    throw validation('NEGATIVE_INVENTORY', `${bin}+${item} would go negative`);
  }
  const ev = { scanId: randomUUID(), session, type, bin, item, delta };
  store.hooks.beforeScanAppend && store.hooks.beforeScanAppend();
  const endOffset = store.appendEvent(ev);
  sess.ops.push({ scanId: ev.scanId, type, bin, item, delta });
  store.saveSession(sess);
  store.saveCursor({ offset: endOffset });
  return ev;
}

function scan(store, { session, bin, item, qty = 1 }) {
  if (!Number.isInteger(qty) || qty < 1) {
    throw validation('INVALID_QTY', `scan qty must be a positive integer, got ${JSON.stringify(qty)}`);
  }
  return capture(store, { session, bin, item, delta: qty, type: 'scan' });
}

function adjust(store, { session, bin, item, delta }) {
  return capture(store, { session, bin, item, delta, type: 'adjust' });
}

// Undo is only allowed while the session is still open.
function undo(store, { session }) {
  validateSessionId(session);
  store.requireInit();
  const sess = store.loadSession(session);
  if (!sess) {
    const state = store.loadState();
    if (state.closedSessions.includes(session)) {
      throw stateErr('CLOSED', `session ${session} is closed; undo is only allowed on open sessions`);
    }
    throw stateErr('SESSION_NOT_FOUND', `session ${session} not found`);
  }
  if (sess.status !== 'open') {
    throw stateErr('CLOSED', `session ${session} is closed; undo is only allowed on open sessions`);
  }
  if (sess.ops.length === 0) throw stateErr('NOTHING_TO_UNDO', `session ${session} has no ops`);
  const removed = sess.ops.pop();
  store.saveSession(sess);
  return removed;
}

// Close: fold session ops into the ledger (single atomic commit), then drop the session.
function close(store, { session }) {
  const sess = loadOpenSession(store, session);
  const state = store.loadState();
  const inventory = { ...state.inventory };
  for (const op of sess.ops) {
    const k = keyOf(op.bin, op.item);
    if ((inventory[k] || 0) + op.delta < 0) {
      throw validation('NEGATIVE_INVENTORY', `closing would drive ${op.bin}+${op.item} negative`);
    }
    inventory[k] = (inventory[k] || 0) + op.delta;
  }
  const node = state.nodeId;
  let seq = state.vv[node] || 0;
  for (const op of sess.ops) {
    seq += 1;
    state.ops.push({ opId: `${node}#${seq}`, node, seq, type: op.type, bin: op.bin, item: op.item, delta: op.delta, session: sess.id });
  }
  state.vv[node] = seq;
  state.inventory = inventory;
  if (!state.closedSessions.includes(sess.id)) state.closedSessions.push(sess.id);
  store.saveState(state); // ledger commit point
  store.deleteSession(sess.id);
  return { session: sess.id, committed: sess.ops.length };
}

module.exports = { begin, scan, adjust, undo, close, capture };
