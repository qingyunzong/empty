'use strict';
const { parseNdjson, topoSort } = require('./sync');

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateSource(node, count, seed) {
  const rand = mulberry32(fnv1a(`${seed}:${node}`));
  const events = [];
  const posted = [];
  const voided = [];
  let lamport = 0;
  let seq = 0;
  const nextId = () => `${node}-${String(++seq).padStart(4, '0')}`;
  const tick = () => ++lamport;
  for (let i = 0; i < count; i++) {
    const roll = rand();
    if (roll < 0.6 || posted.length === 0) {
      const amount = 1 + Math.floor(rand() * 10000);
      events.push({ id: nextId(), kind: 'post', amount, causes: [], lamport: tick(), node });
      posted.push(events[events.length - 1].id);
    } else if (roll < 0.85 || voided.length === 0) {
      const target = posted.splice(Math.floor(rand() * posted.length), 1)[0];
      events.push({ id: nextId(), kind: 'void', causes: [target], lamport: tick(), node });
      voided.push(events[events.length - 1].id);
    } else {
      const target = voided.splice(Math.floor(rand() * voided.length), 1)[0];
      events.push({ id: nextId(), kind: 'revive', causes: [target], lamport: tick(), node });
      posted.push(target);
    }
  }
  return events;
}

function toNdjson(events) {
  return events.map((ev) => JSON.stringify(ev)).join('\n') + '\n';
}

// Deterministic shuffle: assigns each event a random rank, then emits events in
// ascending rank while respecting causality (Kahn with rank priority).
function shuffleEvents(events, seedKey) {
  const rand = mulberry32(fnv1a(seedKey));
  const rank = new Map(events.map((ev) => [ev.id, rand()]));
  const byId = new Map(events.map((ev) => [ev.id, ev]));
  const indeg = new Map(events.map((ev) => [ev.id, ev.causes.length]));
  const dependents = new Map(events.map((ev) => [ev.id, []]));
  for (const ev of events) for (const c of ev.causes) dependents.get(c).push(ev.id);
  const ready = events.filter((ev) => ev.causes.length === 0).map((ev) => ev.id);
  const out = [];
  while (ready.length) {
    ready.sort((x, y) => rank.get(x) - rank.get(y));
    const id = ready.shift();
    out.push(byId.get(id));
    for (const d of dependents.get(id)) {
      indeg.set(d, indeg.get(d) - 1);
      if (indeg.get(d) === 0) ready.push(d);
    }
  }
  if (out.length !== events.length) throw new Error('shuffle failed: cycle?');
  return out;
}

function generatePair(count, seed) {
  const a = generateSource('A', count, seed);
  const b = generateSource('B', count, seed);
  topoSort(parseNdjson(toNdjson(a), 'A'));
  topoSort(parseNdjson(toNdjson(b), 'B'));
  return { a, b };
}

module.exports = { generateSource, generatePair, shuffleEvents, toNdjson, fnv1a, mulberry32 };
