'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { crc32 } = require('./crc32');

const MAGIC = 'EV1';
const EVENTS_FILE = 'events.log';
const INDEX_FILE = 'index.json';
const HEADS_FILE = 'heads.json';

class HistError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'HistError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function canonical(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function crcHex(text) {
  return crc32(Buffer.from(text, 'utf8')).toString(16).padStart(8, '0');
}

function eventId(rec) {
  return 'e' + sha256(canonical({
    kind: rec.kind,
    parents: rec.parents,
    author: rec.author,
    counter: rec.counter,
    payload: rec.payload,
  })).slice(0, 40);
}

function makeEvent({ kind = 'event', parents = [], author, counter, payload = null }) {
  const rec = {
    kind,
    parents: [...parents].sort(),
    author,
    counter,
    payload,
  };
  const body = { id: eventId(rec), ...rec };
  body.crc = crcHex(canonical(body));
  return body;
}

function makeTombstone(target, author, counter) {
  const body = {
    id: 't' + sha256('tombstone:' + target).slice(0, 40),
    kind: 'tombstone',
    target,
    author,
    counter,
  };
  body.crc = crcHex(canonical(body));
  return body;
}

function verifyRecord(rec) {
  if (!rec || typeof rec !== 'object') throw new HistError('ERR_CORRUPT', 'record is not an object');
  const { crc, ...rest } = rec;
  if (typeof crc !== 'string' || crcHex(canonical(rest)) !== crc) {
    throw new HistError('ERR_CORRUPT', `crc mismatch in record ${rec.id}`);
  }
}

function encodeBlock(record) {
  const json = JSON.stringify(record);
  return `${MAGIC} ${Buffer.byteLength(json)} ${crcHex(json)}\n${json}\n`;
}

function decodeBlocks(text) {
  const lines = text.split('\n');
  const records = [];
  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    if (header === '') { i += 1; continue; }
    const m = /^EV1 (\d+) ([0-9a-f]{8})$/.exec(header);
    if (!m) throw new HistError('ERR_CORRUPT', `bad block header: ${JSON.stringify(header)}`);
    const json = lines[i + 1];
    if (json === undefined) throw new HistError('ERR_CORRUPT', 'truncated block body');
    if (Buffer.byteLength(json) !== Number(m[1]) || crcHex(json) !== m[2]) {
      throw new HistError('ERR_CORRUPT', 'block checksum mismatch');
    }
    const rec = JSON.parse(json);
    verifyRecord(rec);
    records.push(rec);
    i += 2;
  }
  return records;
}

function topoOrder(ids, parentsOf) {
  const indeg = new Map();
  const children = new Map();
  for (const id of ids) {
    indeg.set(id, 0);
    children.set(id, []);
  }
  for (const id of ids) {
    for (const p of parentsOf(id)) {
      indeg.set(id, indeg.get(id) + 1);
      children.get(p).push(id);
    }
  }
  const ready = ids.filter((id) => indeg.get(id) === 0).sort();
  const order = [];
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(id);
    for (const c of children.get(id)) {
      indeg.set(c, indeg.get(c) - 1);
      if (indeg.get(c) === 0) {
        const at = ready.findIndex((x) => x > c);
        if (at === -1) ready.push(c); else ready.splice(at, 0, c);
      }
    }
  }
  return order;
}

function validateGraph(events) {
  for (const [id, ev] of events) {
    for (const p of ev.parents) {
      if (!events.has(p)) {
        throw new HistError('ERR_MISSING_PARENT', `event ${id} references missing parent ${p}`, { event: id, parent: p });
      }
    }
  }
  const ids = [...events.keys()];
  const order = topoOrder(ids, (id) => events.get(id).parents);
  if (order.length !== ids.length) {
    const inOrder = new Set(order);
    const cyclic = ids.filter((id) => !inOrder.has(id));
    throw new HistError('ERR_CYCLE', `cycle detected involving ${cyclic.join(',')}`, { events: cyclic });
  }
}

function computeHeads(active) {
  const isParent = new Set();
  for (const ev of active.values()) {
    for (const p of ev.parents) isParent.add(p);
  }
  return [...active.keys()].filter((id) => !isParent.has(id)).sort();
}

function defaultReport(report) {
  process.stderr.write(JSON.stringify({ warning: 'HEADS_REBUILT', ...report }) + '\n');
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function persist(dir, order, heads) {
  fs.writeFileSync(path.join(dir, INDEX_FILE), JSON.stringify({ order }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, HEADS_FILE), JSON.stringify({ heads }, null, 2) + '\n');
}

function loadStore(dir, onReport = defaultReport) {
  const eventsPath = path.join(dir, EVENTS_FILE);
  if (!fs.existsSync(eventsPath)) {
    throw new HistError('ERR_CORRUPT', `history not initialized at ${dir}`);
  }
  const records = decodeBlocks(fs.readFileSync(eventsPath, 'utf8'));
  const events = new Map();
  const tombstoned = new Set();
  for (const rec of records) {
    if (rec.kind === 'tombstone') {
      tombstoned.add(rec.target);
      continue;
    }
    if (events.has(rec.id)) continue;
    events.set(rec.id, rec);
  }
  validateGraph(events);
  const active = new Map([...events].filter(([id]) => !tombstoned.has(id)));
  const order = topoOrder([...active.keys()], (id) => active.get(id).parents.filter((p) => active.has(p)));
  const heads = computeHeads(active);

  const indexFile = readJsonSafe(path.join(dir, INDEX_FILE));
  const headsFile = readJsonSafe(path.join(dir, HEADS_FILE));
  const indexOk = indexFile && Array.isArray(indexFile.order)
    && indexFile.order.length === order.length
    && indexFile.order.every((id, i) => id === order[i]);
  const headsOk = headsFile && Array.isArray(headsFile.heads)
    && [...headsFile.heads].sort().join(',') === heads.join(',');

  let rebuilt = false;
  if (!indexOk || !headsOk) {
    persist(dir, order, heads);
    rebuilt = true;
    onReport({
      rebuilt: true,
      indexOk: Boolean(indexOk),
      headsOk: Boolean(headsOk),
      fileHeads: headsFile && headsFile.heads ? headsFile.heads : null,
      computedHeads: heads,
    });
  }
  return { dir, events, active, tombstoned, order, heads, rebuilt };
}

function init(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const eventsPath = path.join(dir, EVENTS_FILE);
  if (!fs.existsSync(eventsPath)) fs.writeFileSync(eventsPath, '');
  persist(dir, [], []);
  return { dir };
}

function nextCounter(store, author) {
  let max = 0;
  for (const ev of store.events.values()) {
    if (ev.author === author && ev.counter > max) max = ev.counter;
  }
  return max + 1;
}

function appendBlock(dir, record) {
  fs.appendFileSync(path.join(dir, EVENTS_FILE), encodeBlock(record));
}

function append(dir, { author, payload, parents }, onReport) {
  if (!author) throw new HistError('ERR_HEAD', 'append requires an author');
  const store = loadStore(dir, onReport);
  const useParents = parents === undefined ? store.heads : [...parents].sort();
  for (const p of useParents) {
    if (!store.active.has(p)) {
      throw new HistError('ERR_MISSING_PARENT', `missing parent ${p}`, { parent: p });
    }
  }
  const rec = makeEvent({ kind: 'event', parents: useParents, author, counter: nextCounter(store, author), payload });
  if (!store.events.has(rec.id)) {
    appendBlock(dir, rec);
  }
  const after = loadStore(dir, () => {});
  persist(dir, after.order, after.heads);
  return { id: rec.id, heads: after.heads };
}

function isAncestorStore(store, a, b) {
  if (a === b) return false;
  const seen = new Set();
  const stack = [b];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === a) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const ev = store.events.get(id);
    if (ev) stack.push(...ev.parents);
  }
  return false;
}

function requireActive(store, id, role) {
  if (!store.active.has(id)) {
    throw new HistError('ERR_HEAD', `unknown ${role} head ${id}`, { head: id });
  }
}

function isAncestor(dir, a, b, onReport) {
  const store = loadStore(dir, onReport);
  requireActive(store, a, 'ancestor');
  requireActive(store, b, 'descendant');
  return isAncestorStore(store, a, b);
}

function merge(dir, a, b, { author = 'merge' } = {}, onReport) {
  const store = loadStore(dir, onReport);
  requireActive(store, a, 'merge');
  requireActive(store, b, 'merge');
  if (a === b) return { head: a, created: false };
  if (isAncestorStore(store, a, b)) return { head: b, created: false };
  if (isAncestorStore(store, b, a)) return { head: a, created: false };
  const parents = [a, b].sort();
  for (const ev of store.events.values()) {
    if (ev.kind === 'merge' && ev.parents.join(',') === parents.join(',')) {
      return { head: ev.id, created: false };
    }
  }
  const rec = makeEvent({
    kind: 'merge',
    parents,
    author,
    counter: nextCounter(store, author),
    payload: { merged: parents },
  });
  let created = false;
  if (!store.events.has(rec.id)) {
    appendBlock(dir, rec);
    created = true;
  }
  const after = loadStore(dir, () => {});
  persist(dir, after.order, after.heads);
  return { head: rec.id, created };
}

function heads(dir, onReport) {
  const store = loadStore(dir, onReport);
  return { heads: store.heads, rebuilt: store.rebuilt };
}

function checkout(dir, head, onReport) {
  const store = loadStore(dir, onReport);
  requireActive(store, head, 'checkout');
  const closure = new Set();
  const stack = [head];
  while (stack.length > 0) {
    const id = stack.pop();
    if (closure.has(id)) continue;
    closure.add(id);
    for (const p of store.events.get(id).parents) {
      if (store.active.has(p)) stack.push(p);
    }
  }
  const order = topoOrder([...closure], (id) => store.events.get(id).parents.filter((p) => closure.has(p)));
  return order.map((id) => {
    const ev = store.events.get(id);
    return { id, kind: ev.kind, author: ev.author, counter: ev.counter, payload: ev.payload };
  });
}

function undo(dir, target, { author = 'undo' } = {}, onReport) {
  const store = loadStore(dir, onReport);
  if (!store.events.has(target) || store.tombstoned.has(target)) {
    throw new HistError('ERR_HEAD', `unknown head ${target}`, { head: target });
  }
  const children = [...store.active.values()].filter((ev) => ev.parents.includes(target));
  if (children.length > 0) {
    throw new HistError('ERR_CONFLICT', `cannot undo non-leaf head ${target}`, {
      head: target,
      children: children.map((ev) => ev.id),
    });
  }
  const tomb = makeTombstone(target, author, nextCounter(store, author));
  appendBlock(dir, tomb);
  const after = loadStore(dir, () => {});
  persist(dir, after.order, after.heads);
  return { undone: target, tombstone: tomb.id, heads: after.heads };
}

module.exports = {
  HistError,
  init,
  append,
  merge,
  heads,
  isAncestor,
  checkout,
  undo,
  loadStore,
  makeEvent,
  encodeBlock,
  canonical,
};
