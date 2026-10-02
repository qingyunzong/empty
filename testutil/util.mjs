import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonical } from '../src/model.js';

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mvrepo-test-'));
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent re-implementation of happens-before for cross-checking.
export function buildHb(events) {
  const preds = new Map(events.map((e) => [e.id, new Set()]));
  for (const e of events) for (const d of e.deps ?? []) preds.get(e.id).add(d);
  const byProc = new Map();
  for (const e of events) {
    if (!byProc.has(e.processId)) byProc.set(e.processId, []);
    byProc.get(e.processId).push(e);
  }
  for (const list of byProc.values()) {
    for (const a of list) for (const b of list) if (a.clock < b.clock) preds.get(b.id).add(a.id);
  }
  return preds;
}

function closure(preds) {
  const anc = new Map();
  const compute = (id) => {
    if (anc.has(id)) return anc.get(id);
    const out = new Set();
    anc.set(id, out);
    for (const p of preds.get(id) ?? []) {
      out.add(p);
      for (const q of compute(p)) out.add(q);
    }
    return out;
  };
  for (const id of preds.keys()) compute(id);
  const desc = new Map([...preds.keys()].map((id) => [id, new Set()]));
  for (const [id, as] of anc) for (const a of as) desc.get(a)?.add(id);
  return { anc, desc };
}

function materialize(commits) {
  const state = new Map();
  for (const c of commits) {
    for (const op of c.ops) {
      if (op.op === 'assert') state.set(op.key, op.value ?? null);
      else state.delete(op.key);
    }
  }
  return state;
}

function viewEquals(view, state) {
  const entries = Object.entries(view);
  if (entries.length !== state.size) return false;
  for (const [k, v] of entries) {
    if (!state.has(k) || canonical(state.get(k)) !== canonical(v)) return false;
  }
  return true;
}

// Brute force: enumerate every topological order of commits; the history is
// linearizable iff some order gives every read a matching prefix cut.
export function bruteForceLinearizable(log) {
  const events = log.events;
  const preds = buildHb(events);
  const { anc, desc } = closure(preds);
  const commits = events.filter((e) => e.type === 'commit');
  const reads = events.filter((e) => e.type === 'read');
  const cSet = new Set(commits.map((c) => c.id));
  const readReq = reads.map((r) => ({
    view: r.view,
    inc: [...anc.get(r.id)].filter((x) => cSet.has(x)),
    exc: new Set([...desc.get(r.id)].filter((x) => cSet.has(x))),
  }));
  const commitPred = commits.map((c) => [...anc.get(c.id)].filter((x) => cSet.has(x)));

  const n = commits.length;
  const placed = new Array(n).fill(false);
  const orderIdx = [];
  function* topo() {
    if (orderIdx.length === n) {
      yield orderIdx;
      return;
    }
    for (let i = 0; i < n; i++) {
      if (placed[i]) continue;
      if (!commitPred[i].every((p) => placed[commits.findIndex((c) => c.id === p)])) continue;
      placed[i] = true;
      orderIdx.push(i);
      yield* topo();
      orderIdx.pop();
      placed[i] = false;
    }
  }
  for (const ord of topo()) {
    const orderedCommits = ord.map((i) => commits[i]);
    const ok = readReq.every((req) => {
      const state = new Map();
      for (let k = 0; k <= n; k++) {
        if (k > 0) {
          for (const op of orderedCommits[k - 1].ops) {
            if (op.op === 'assert') state.set(op.key, op.value ?? null);
            else state.delete(op.key);
          }
        }
        const prefixSet = new Set(orderedCommits.slice(0, k).map((c) => c.id));
        if (!req.inc.every((x) => prefixSet.has(x))) continue;
        if ([...prefixSet].some((x) => req.exc.has(x))) continue;
        if (viewEquals(req.view, state)) return true;
      }
      return false;
    });
    if (ok) return true;
  }
  return false;
}

// Generates a random history that is linearizable by construction
// (reads observe real cuts of a random topological order), optionally
// corrupted so no serial order can explain the last read.
export function genHistory(rng, { procs = 3, perProc = 3, reads = 2, corrupt = false } = {}) {
  const events = [];
  let vc = 0;
  const commitsByProc = [];
  for (let p = 0; p < procs; p++) {
    const list = [];
    for (let i = 1; i <= perProc; i++) {
      const deps = i > 1 ? [list[list.length - 1].id] : [];
      if (p > 0 && i > 1 && rng() < 0.4 && commitsByProc[p - 1].length >= i - 1) {
        deps.push(commitsByProc[p - 1][i - 2].id);
      }
      const ops = [];
      const key = `k${Math.floor(rng() * 3)}`;
      // mix unique and shared values: shared values mean several commits can
      // be the "savior" for a read, exercising the unconstrained search path
      const value = rng() < 0.5 ? `v${vc++}` : `shared${Math.floor(rng() * 3)}`;
      if (rng() < 0.85) ops.push({ op: 'assert', key, value });
      else ops.push({ op: 'retract', key });
      const c = { type: 'commit', id: `p${p}c${i}`, processId: `p${p}`, clock: i, deps, ops };
      events.push(c);
      list.push(c);
    }
    commitsByProc.push(list);
  }
  const commits = events.filter((e) => e.type === 'commit');
  const preds = buildHb(events);
  const { anc } = closure(preds);
  // random topological order
  const remaining = new Set(commits.map((c) => c.id));
  const order = [];
  while (remaining.size) {
    const ready = [...remaining].filter((id) =>
      [...anc.get(id)].every((a) => !remaining.has(a))
    );
    const pick = ready[Math.floor(rng() * ready.length)];
    remaining.delete(pick);
    order.push(commits.find((c) => c.id === pick));
  }
  for (let r = 0; r < reads; r++) {
    const k = 1 + Math.floor(rng() * order.length);
    const cut = order.slice(0, k);
    const state = materialize(cut);
    const view = Object.fromEntries(state);
    if (corrupt && r === reads - 1) {
      const keys = Object.keys(view);
      if (keys.length) view[keys[0]] = 'bogus-never-asserted';
      else view.k0 = 'bogus-never-asserted';
    }
    events.push({
      type: 'read',
      id: `r${r}`,
      processId: `pr${r}`,
      clock: 1,
      deps: cut.length ? [cut[cut.length - 1].id] : [],
      view,
    });
  }
  return { events };
}
