import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { mergeClocks } from './clock.js';
import { hashEvent } from './event.js';

export function emptyStore(replica) {
  return { replica, clock: {}, orders: {} };
}

export function loadStore(path, replica) {
  if (!existsSync(path)) return emptyStore(replica);
  const store = JSON.parse(readFileSync(path, 'utf8'));
  if (replica) store.replica = replica;
  return store;
}

export function saveStore(path, store) {
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n');
}

export function issueEvent(store, orderId, type, payload = {}) {
  store.clock[store.replica] = (store.clock[store.replica] || 0) + 1;
  const order = (store.orders[orderId] ??= { orderId, events: [] });
  const prev = order.events[order.events.length - 1];
  const event = {
    eventId: `${store.replica}-${store.clock[store.replica]}`,
    type,
    orderId,
    replica: store.replica,
    clock: { ...store.clock },
    prevHash: prev ? prev.hash : null,
    ...payload,
  };
  event.hash = hashEvent(event);
  order.events.push(event);
  return event;
}

export function mergeStores(target, source) {
  for (const orderId of Object.keys(source.orders)) {
    const targetOrder = (target.orders[orderId] ??= { orderId, events: [] });
    const known = new Set(targetOrder.events.map((e) => e.eventId));
    for (const event of source.orders[orderId].events) {
      if (!known.has(event.eventId)) targetOrder.events.push(event);
    }
  }
  target.clock = mergeClocks(target.clock, source.clock);
  return target;
}
