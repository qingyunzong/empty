'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VALID_KINDS = new Set(['post', 'void', 'revive']);
const ID_RE = /^[A-Za-z0-9_-]+$/;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function assertEvent(ev, where) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
    fail(3, `${where}: event must be an object`);
  }
  if (typeof ev.id !== 'string' || !ID_RE.test(ev.id)) fail(3, `${where}: invalid id`);
  if (!VALID_KINDS.has(ev.kind)) fail(3, `${where}: invalid kind ${JSON.stringify(ev.kind)}`);
  if (ev.kind === 'post' && !Number.isInteger(ev.amount)) {
    fail(3, `${where}: amount must be an integer, got ${JSON.stringify(ev.amount)}`);
  }
  if (ev.kind !== 'post' && ev.amount !== undefined) {
    fail(3, `${where}: amount only allowed on post`);
  }
  if (!Array.isArray(ev.causes) || ev.causes.some((c) => typeof c !== 'string')) {
    fail(3, `${where}: causes must be an array of strings`);
  }
  if (new Set(ev.causes).size !== ev.causes.length) fail(3, `${where}: duplicate causes`);
  if (!Number.isInteger(ev.lamport) || ev.lamport < 1) fail(3, `${where}: invalid lamport`);
  if (typeof ev.node !== 'string' || !ev.node) fail(3, `${where}: invalid node`);
}

function canonicalEvent(ev) {
  const out = { id: ev.id, kind: ev.kind, causes: ev.causes, lamport: ev.lamport, node: ev.node };
  if (ev.kind === 'post') out.amount = ev.amount;
  return out;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function parseNdjson(text, sourceName) {
  const events = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      fail(3, `${sourceName}:${i + 1}: invalid JSON`);
    }
    assertEvent(ev, `${sourceName}:${i + 1}`);
    events.push(canonicalEvent(ev));
  }
  return events;
}

function topoSort(events) {
  const byId = new Map();
  for (const ev of events) {
    if (byId.has(ev.id)) fail(3, `duplicate event id ${ev.id}`);
    byId.set(ev.id, ev);
  }
  // Canonical key makes the traversal fully determined by the event set,
  // independent of file/exchange order.
  const keyOf = (ev) => `${String(ev.lamport).padStart(12, '0')} ${ev.node} ${ev.id}`;
  const causeOf = (id) => {
    const ev = byId.get(id);
    if (!ev) fail(3, `unknown cause ${id}`);
    return ev;
  };
  const memo = new Map(); // id -> 0 unknown, 1 in-stack, 2 done
  const order = [];
  const stack = [];
  const visit = (id) => {
    const state = memo.get(id);
    if (state === 2) return;
    if (state === 1) fail(3, `cyclic causality involving ${id}`);
    const ev = causeOf(id);
    memo.set(id, 1);
    stack.push(id);
    const causes = [...ev.causes].sort((a, b) => {
      const ka = keyOf(causeOf(a));
      const kb = keyOf(causeOf(b));
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    for (const c of causes) visit(c);
    stack.pop();
    memo.set(id, 2);
    order.push(ev);
  };
  const roots = [...events].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  for (const ev of roots) visit(ev.id);
  return order;
}

function computeEffective(sorted) {
  const state = new Map(); // id -> { status: 'active'|'voided', amount }
  const targetOf = new Map(); // event id -> post id it affects
  for (const ev of sorted) {
    if (ev.kind === 'post') {
      if (state.has(ev.id)) fail(3, `duplicate post for id ${ev.id}`);
      state.set(ev.id, { status: 'active', amount: ev.amount });
      targetOf.set(ev.id, ev.id);
    } else {
      // void/revive act on the post reachable through their causes; a void
      // only affects a visible (already merged) post, revive re-activates it.
      let target = null;
      for (const c of ev.causes) {
        if (targetOf.has(c)) {
          target = targetOf.get(c);
          break;
        }
      }
      if (target === null) continue; // target not visible -> no-op
      targetOf.set(ev.id, target);
      const cur = state.get(target);
      if (ev.kind === 'void') {
        if (cur.status === 'active') cur.status = 'voided';
      } else if (cur.status === 'voided') {
        cur.status = 'active';
      }
    }
  }
  const effective = [];
  for (const [id, s] of state) if (s.status === 'active') effective.push({ id, amount: s.amount });
  effective.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return effective;
}

function detectConflicts(aEvents, bEvents) {
  const pa = new Map();
  for (const ev of aEvents) if (ev.kind === 'post') pa.set(ev.id, ev.amount);
  const conflicts = [];
  const seen = new Set();
  for (const ev of bEvents) {
    if (ev.kind !== 'post' || !pa.has(ev.id)) continue;
    const amountA = pa.get(ev.id);
    if (amountA !== ev.amount) {
      const amounts = [amountA, ev.amount].sort((x, y) => x - y);
      conflicts.push({ id: ev.id, amounts, resolution: 'excluded' });
      seen.add(ev.id);
    }
  }
  conflicts.sort((x, y) => (x.id < y.id ? -1 : 1));
  return { conflicts, conflictIds: seen };
}

function mergeEvents(aEvents, bEvents, aName = 'A', bName = 'B') {
  const { conflicts, conflictIds } = detectConflicts(aEvents, bEvents);
  const combined = [...aEvents, ...bEvents].filter((ev) => !(ev.kind === 'post' && conflictIds.has(ev.id)));
  const sorted = topoSort(combined);
  const effective = computeEffective(sorted);
  const balance = effective.reduce((sum, e) => sum + e.amount, 0);
  return { log: sorted, effective, balance, conflicts, sources: [aName, bName] };
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(
    path.dirname(filePath),
    `.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
  );
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function mergePaths(aPath, bPath, outDir) {
  const aEvents = parseNdjson(fs.readFileSync(aPath, 'utf8'), path.basename(aPath));
  const bEvents = parseNdjson(fs.readFileSync(bPath, 'utf8'), path.basename(bPath));
  const result = mergeEvents(aEvents, bEvents, path.basename(aPath), path.basename(bPath));
  const logText = result.log.map((ev) => JSON.stringify(ev)).join('\n') + '\n';
  const state = {
    balance: result.balance,
    effective: result.effective,
    conflicts: result.conflicts,
    sources: result.sources,
    hash: sha256Hex(logText),
  };
  atomicWrite(path.join(outDir, 'log.ndjson'), logText);
  atomicWrite(path.join(outDir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  atomicWrite(path.join(outDir, 'conflict.json'), JSON.stringify(result.conflicts, null, 2) + '\n');
  return result;
}

module.exports = {
  parseNdjson,
  topoSort,
  computeEffective,
  detectConflicts,
  mergeEvents,
  mergePaths,
  atomicWrite,
  canonicalJson,
  sha256Hex,
};
