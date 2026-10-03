'use strict';
const crypto = require('node:crypto');

class SyncError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SyncError';
    this.code = 3;
  }
}

const KINDS = new Set(['post', 'void', 'revive']);

function validateEvent(e, where) {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) {
    throw new SyncError(`${where}: event must be an object`);
  }
  if (typeof e.id !== 'string' || e.id.length === 0) {
    throw new SyncError(`${where}: missing id`);
  }
  if (!KINDS.has(e.kind)) {
    throw new SyncError(`${where}: unknown kind ${JSON.stringify(e.kind)}`);
  }
  if (!Array.isArray(e.causes) || e.causes.some((c) => typeof c !== 'string')) {
    throw new SyncError(`${where}: causes must be an array of strings`);
  }
  if (!Number.isInteger(e.lamport) || e.lamport < 0) {
    throw new SyncError(`${where}: lamport must be a non-negative integer`);
  }
  if (typeof e.node !== 'string' || e.node.length === 0) {
    throw new SyncError(`${where}: missing node`);
  }
  if (e.kind === 'post') {
    if (!Number.isInteger(e.amount)) {
      throw new SyncError(`${where}: amount must be an integer, got ${JSON.stringify(e.amount)}`);
    }
  } else if (typeof e.target !== 'string' || e.target.length === 0) {
    throw new SyncError(`${where}: ${e.kind} requires a target`);
  }
}

function parseNdjson(text, source) {
  const events = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      throw new SyncError(`${source}:${i + 1}: invalid JSON`);
    }
    validateEvent(e, `${source}:${i + 1}`);
    events.push(e);
  }
  return events;
}

function canonical(e) {
  const o = {
    id: e.id,
    kind: e.kind,
    causes: [...e.causes].sort(),
    lamport: e.lamport,
    node: e.node,
  };
  if (e.kind === 'post') o.amount = e.amount;
  else o.target = e.target;
  return o;
}

function dedupe(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const k = JSON.stringify(canonical(e));
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

function compareEvents(a, b) {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.node !== b.node) return a.node < b.node ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return (a.amount || 0) - (b.amount || 0);
}

// Deterministic causal (topological) sort. Ties broken by
// (lamport, node, id, kind, amount) so the merged log is identical
// regardless of input file order.
function topoSort(events) {
  const byId = new Map();
  for (const e of events) {
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e);
  }
  const preds = new Map(events.map((e) => [e, new Set()]));
  for (const e of events) {
    for (const c of e.causes) {
      const providers = byId.get(c);
      if (!providers) {
        throw new SyncError(
          `unknown cause ${JSON.stringify(c)} referenced by ${e.id} (${e.node}#${e.lamport})`
        );
      }
      for (const p of providers) {
        if (p !== e) preds.get(e).add(p);
      }
    }
  }
  const succs = new Map(events.map((e) => [e, new Set()]));
  for (const [e, ps] of preds) {
    for (const p of ps) succs.get(p).add(e);
  }
  const indeg = new Map(events.map((e) => [e, preds.get(e).size]));
  const ready = events.filter((e) => indeg.get(e) === 0).sort(compareEvents);
  const ordered = [];
  while (ready.length) {
    const e = ready.shift();
    ordered.push(e);
    for (const s of succs.get(e)) {
      const d = indeg.get(s) - 1;
      indeg.set(s, d);
      if (d === 0) {
        let i = ready.length;
        while (i > 0 && compareEvents(ready[i - 1], s) > 0) i--;
        ready.splice(i, 0, s);
      }
    }
  }
  if (ordered.length !== events.length) {
    throw new SyncError('cyclic causality detected');
  }
  return { ordered, preds };
}

function makeAncestorChecker(preds) {
  const memo = new Map();
  function ancestors(e) {
    if (memo.has(e)) return memo.get(e);
    const acc = new Set();
    memo.set(e, acc);
    for (const p of preds.get(e)) {
      acc.add(p);
      for (const a of ancestors(p)) acc.add(a);
    }
    return acc;
  }
  return (ancestor, e) => ancestors(e).has(ancestor);
}

// Semantics:
// - post(id, amount): credits amount once per id (identical duplicates deduped).
// - void(target=txid): revokes a post only if that post is causally visible
//   (an ancestor of the void). Concurrent posts are NOT revoked.
// - revive(target=voidId): explicitly undoes a void that causally precedes it.
//   A void of a void is meaningless; undoing a void requires revive.
// - posts sharing an id with differing amounts are a conflict: never silently
//   overwritten, excluded from the balance, and recorded as a certificate.
function evaluate(events) {
  const { ordered, preds } = topoSort(events);
  const isAncestor = makeAncestorChecker(preds);

  const postsById = new Map();
  const voids = [];
  const revives = [];
  for (const e of ordered) {
    if (e.kind === 'post') {
      if (!postsById.has(e.id)) postsById.set(e.id, []);
      postsById.get(e.id).push(e);
    } else if (e.kind === 'void') {
      voids.push(e);
    } else {
      revives.push(e);
    }
  }

  const conflicts = [];
  const conflicted = new Set();
  for (const id of [...postsById.keys()].sort()) {
    const posts = postsById.get(id);
    const amounts = [...new Set(posts.map((p) => p.amount))].sort((x, y) => x - y);
    if (amounts.length > 1) {
      conflicted.add(id);
      let concurrent = false;
      for (let i = 0; i < posts.length && !concurrent; i++) {
        for (let j = i + 1; j < posts.length; j++) {
          if (!isAncestor(posts[i], posts[j]) && !isAncestor(posts[j], posts[i])) {
            concurrent = true;
            break;
          }
        }
      }
      conflicts.push({
        id,
        amounts,
        nodes: [...new Set(posts.map((p) => p.node))].sort(),
        concurrent,
      });
    }
  }

  const revivedVoids = new Set();
  for (const r of revives) {
    for (const v of voids) {
      if (v.id === r.target && isAncestor(v, r)) revivedVoids.add(v);
    }
  }

  const voidedTx = new Set();
  for (const v of voids) {
    if (revivedVoids.has(v)) continue;
    const posts = postsById.get(v.target) || [];
    if (posts.some((p) => isAncestor(p, v))) voidedTx.add(v.target);
  }

  const effective = [];
  let balance = 0;
  for (const [id, posts] of postsById) {
    if (conflicted.has(id) || voidedTx.has(id)) continue;
    effective.push(id);
    balance += posts[0].amount;
  }
  effective.sort();

  return { ordered, balance, conflicts, effective, voidedTx, conflicted };
}

function mergeEvents(events) {
  const deduped = dedupe(events);
  const { ordered, balance, conflicts, effective } = evaluate(deduped);
  const log = ordered.map(canonical);
  const logText = log.map((o) => JSON.stringify(o)).join('\n') + (log.length ? '\n' : '');
  const hash = crypto
    .createHash('sha256')
    .update(logText)
    .update(JSON.stringify({ balance, conflicts }))
    .digest('hex');
  return { log, logText, balance, conflicts, effective, hash };
}

function mergeTexts(textA, textB) {
  const events = [
    ...parseNdjson(textA, 'source-a'),
    ...parseNdjson(textB, 'source-b'),
  ];
  return mergeEvents(events);
}

module.exports = {
  SyncError,
  parseNdjson,
  canonical,
  dedupe,
  topoSort,
  evaluate,
  mergeEvents,
  mergeTexts,
};
