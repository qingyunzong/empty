#!/usr/bin/env node
import { loadStore, saveStore, issueEvent, mergeStores } from './src/store.js';
import { reduceOrder, NEW, CANCELED, MATCHED, CONFLICT } from './src/machine.js';
import { verifyEvent } from './src/event.js';

function fail(code) {
  process.stdout.write(JSON.stringify({ error: code }) + '\n');
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    db: process.env.ORDER_DB || 'orders.json',
    replica: process.env.REPLICA || null,
    reason: null,
    by: null,
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') opts.db = argv[++i];
    else if (a === '--replica') opts.replica = argv[++i];
    else if (a === '--reason') opts.reason = argv[++i];
    else if (a === '--by') opts.by = argv[++i];
    else pos.push(a);
  }
  return { opts, pos };
}

function view(orderId, order) {
  const r = reduceOrder(order.events);
  return {
    orderId,
    state: r.state,
    conflict: r.conflict !== null,
    events: order.events,
  };
}

function getOrder(store, orderId) {
  const order = store.orders[orderId];
  if (!order) fail('not-found');
  return order;
}

function buildCert(orderId, order) {
  const r = reduceOrder(order.events);
  const hashesOk = order.events.every(verifyEvent);
  let valid = hashesOk;
  let certificate = null;
  if (r.conflict) {
    if (!r.resolution) {
      valid = false;
    } else {
      certificate = {
        decision: r.resolution.decision,
        reason: r.resolution.reason ?? null,
        by: r.resolution.by ?? null,
        resolveEventId: r.resolution.eventId,
        cancelEventId: r.conflict.cancel.eventId,
        matchEventId: r.conflict.match.eventId,
        hash: r.resolution.hash,
      };
    }
  }
  return { orderId, state: r.state, valid, certificate };
}

const { opts, pos } = parseArgs(process.argv.slice(2));
const cmd = pos[0];

if (!cmd) fail('usage');

const store = loadStore(opts.db, opts.replica);

switch (cmd) {
  case 'create': {
    const orderId = pos[1];
    if (!orderId) fail('usage');
    if (store.orders[orderId]) fail('exists');
    issueEvent(store, orderId, 'create');
    saveStore(opts.db, store);
    process.stdout.write(JSON.stringify(view(orderId, store.orders[orderId])) + '\n');
    break;
  }
  case 'cancel':
  case 'match': {
    const orderId = pos[1];
    if (!orderId) fail('usage');
    const order = getOrder(store, orderId);
    const { state } = reduceOrder(order.events);
    if (state === CONFLICT) fail('conflict');
    if (cmd === 'cancel') {
      if (state === MATCHED) fail('already-matched');
      if (state === CANCELED) fail('already-canceled');
    } else {
      if (state === CANCELED) fail('already-canceled');
      if (state === MATCHED) fail('already-matched');
    }
    issueEvent(store, orderId, cmd);
    saveStore(opts.db, store);
    process.stdout.write(JSON.stringify(view(orderId, order)) + '\n');
    break;
  }
  case 'resolve': {
    const orderId = pos[1];
    const decision = pos[2];
    if (!orderId || !decision) fail('usage');
    if (decision !== CANCELED && decision !== MATCHED) fail('invalid-state');
    const order = getOrder(store, orderId);
    const { state } = reduceOrder(order.events);
    if (state !== CONFLICT) fail('no-conflict');
    issueEvent(store, orderId, 'resolve', {
      decision,
      reason: opts.reason,
      by: opts.by,
    });
    saveStore(opts.db, store);
    process.stdout.write(JSON.stringify(view(orderId, order)) + '\n');
    break;
  }
  case 'merge': {
    const file = pos[1];
    if (!file) fail('usage');
    let other;
    try {
      other = loadStore(file, null);
    } catch {
      fail('bad-file');
    }
    mergeStores(store, other);
    saveStore(opts.db, store);
    const orders = {};
    for (const [id, order] of Object.entries(store.orders)) {
      orders[id] = reduceOrder(order.events).state;
    }
    process.stdout.write(JSON.stringify({ merged: file, orders }) + '\n');
    break;
  }
  case 'state': {
    const orderId = pos[1];
    if (!orderId) fail('usage');
    process.stdout.write(JSON.stringify(view(orderId, getOrder(store, orderId))) + '\n');
    break;
  }
  case 'cert': {
    const orderId = pos[1];
    if (!orderId) fail('usage');
    process.stdout.write(JSON.stringify(buildCert(orderId, getOrder(store, orderId))) + '\n');
    break;
  }
  default:
    fail('unknown-command');
}
