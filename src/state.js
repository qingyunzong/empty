import { TextIndex } from './textindex.js';
import { makeCert, MerkleLog } from './certs.js';
import { sha256 } from './hash.js';
import { LineageError, E_CYCLE, E_INPUT } from './errors.js';

// Materialized view of the event log at a time slice. Events are applied in
// (ts, append) order; corrections whose endpoints do not exist yet stay
// pending and are applied as soon as their dependencies appear (a pending
// correction is deferred, never treated as unsatisfiable).
export function buildState(events, atTs = Infinity) {
  const s = {
    batches: new Map(), // id -> {id, text, parents:Set, children:Set, tombstone, ts}
    index: new TextIndex(),
    certLog: new MerkleLog(),
    certIndex: new Map(), // cert hash -> leaf index
    certs: new Map(), // id -> [cert versions]
    pending: [], // deferred corrections
  };
  for (const ev of events) {
    if (ev.ts > atTs) break; // log is ts-ordered (enforced on append)
    applyEvent(s, ev);
    drainPending(s);
  }
  return s;
}

function applyEvent(s, ev) {
  switch (ev.type) {
    case 'add': {
      if (s.batches.has(ev.id)) {
        throw new LineageError(E_INPUT, `duplicate batch ${ev.id}`);
      }
      const parents = new Set(ev.parents ?? []);
      for (const p of parents) {
        if (!s.batches.has(p)) {
          throw new LineageError(E_INPUT, `unknown parent batch ${p}`);
        }
      }
      const node = {
        id: ev.id,
        text: ev.text ?? '',
        parents,
        children: new Set(),
        tombstone: 0,
        ts: ev.ts,
      };
      s.batches.set(ev.id, node);
      for (const p of parents) s.batches.get(p).children.add(ev.id);
      s.index.add(ev.id, node.text);
      issueCert(s, node);
      break;
    }
    case 'correct':
      applyCorrection(s, ev);
      break;
    case 'delete': {
      const n = s.batches.get(ev.id);
      if (!n) throw new LineageError(E_INPUT, `unknown batch ${ev.id}`);
      if (!n.tombstone) {
        n.tombstone = 1;
        issueCert(s, n); // tombstoned cert: deletion stays provable
      }
      break;
    }
    default:
      throw new LineageError(E_INPUT, `unknown event type ${ev.type}`);
  }
}

// Reverse-compensating correction: remove edge (from -> child), add edge
// (to -> child), and record a new certificate version for the child.
function applyCorrection(s, ev) {
  const child = s.batches.get(ev.child);
  const to = s.batches.get(ev.to);
  if (!child || !to) {
    s.pending.push(ev); // deferred, not unsatisfiable
    return;
  }
  if (ev.to === ev.child || reachable(s, ev.child, ev.to, 'children')) {
    throw new LineageError(
      E_CYCLE,
      `correction ${ev.from}->${ev.to} on ${ev.child} would create a cycle`,
    );
  }
  const from = s.batches.get(ev.from);
  if (from) {
    from.children.delete(ev.child);
    child.parents.delete(ev.from);
  }
  child.parents.add(ev.to);
  to.children.add(ev.child);
  issueCert(s, child);
}

function drainPending(s) {
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < s.pending.length; i++) {
      const ev = s.pending[i];
      if (s.batches.has(ev.child) && s.batches.has(ev.to)) {
        s.pending.splice(i, 1);
        applyCorrection(s, ev);
        progress = true;
        break;
      }
    }
  }
}

function reachable(s, fromId, targetId, dir) {
  const seen = new Set([fromId]);
  const stack = [fromId];
  while (stack.length) {
    const n = s.batches.get(stack.pop());
    for (const nb of n[dir]) {
      if (nb === targetId) return true;
      if (!seen.has(nb)) {
        seen.add(nb);
        stack.push(nb);
      }
    }
  }
  return false;
}

function issueCert(s, node) {
  const versions = s.certs.get(node.id) ?? [];
  const parentHashes = [...node.parents].map((p) => s.certs.get(p).at(-1).hash);
  const cert = makeCert({
    id: node.id,
    parentHashes,
    textHash: sha256(node.text),
    tombstone: node.tombstone,
    version: versions.length,
  });
  versions.push(cert);
  s.certs.set(node.id, versions);
  const idx = s.certLog.append(cert.hash);
  s.certIndex.set(cert.hash, idx);
}

// Enumerate ancestors (dir='parents') or descendants (dir='children').
// Tombstoned nodes are masked out of the live result but traversal continues
// through them, and they are reported separately.
export function walk(s, id, dir) {
  if (!s.batches.has(id)) throw new LineageError(E_INPUT, `unknown batch ${id}`);
  const live = [];
  const masked = [];
  const seen = new Set([id]);
  const stack = [id];
  while (stack.length) {
    const n = s.batches.get(stack.pop());
    for (const nb of n[dir]) {
      if (seen.has(nb)) continue;
      seen.add(nb);
      const node = s.batches.get(nb);
      (node.tombstone ? masked : live).push(nb);
      stack.push(nb);
    }
  }
  return { live, masked };
}

export function searchMask(s, ids) {
  const live = [];
  const masked = [];
  for (const id of ids) {
    const n = s.batches.get(id);
    if (!n) continue;
    (n.tombstone ? masked : live).push(id);
  }
  return { live, masked };
}
