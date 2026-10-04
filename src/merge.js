import { merge3, diffStates, applyOps } from './model.js';
import { canonical, sha, deepEq } from './util.js';
import { err } from './errors.js';

// --- version DAG ancestry ---------------------------------------------------

export function ancestorSet(repo, view, id, memo = new Map()) {
  if (memo.has(id)) return memo.get(id);
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    const x = stack.pop();
    if (out.has(x)) continue;
    out.add(x);
    const v = repo.getVersion(view, x);
    for (const p of v.parents) stack.push(p);
  }
  memo.set(id, out);
  return out;
}

// Lowest common ancestors: common ancestors that are not proper ancestors of
// any other common ancestor.
export function lcaSet(repo, view, a, b) {
  const memo = new Map();
  const A = ancestorSet(repo, view, a, memo);
  const B = ancestorSet(repo, view, b, memo);
  const common = [...A].filter((x) => B.has(x));
  return common.filter((c) => !common.some((d) => d !== c && ancestorSet(repo, view, d, memo).has(c)));
}

function stateOf(repo, view, id) {
  return repo.getVersion(view, id).state;
}

// Merge base state. A single LCA contributes its materialized state; multiple
// LCAs (criss-cross) are merged pairwise with an empty base, and any key that
// still conflicts inside the virtual base degrades to unknown (never fails).
export function baseStateOf(repo, view, bases) {
  if (bases.length === 0) return {};
  let acc = stateOf(repo, view, bases[0]);
  for (const b of bases.slice(1)) {
    acc = merge3({}, acc, stateOf(repo, view, b)).state;
  }
  return acc;
}

// Three-way merge of two versions' row states (no side effects).
export function mergeStates(repo, view, a, b) {
  if (a === b) return { state: stateOf(repo, view, a), conflicts: [], bases: [a] };
  const bases = lcaSet(repo, view, a, b);
  const base = baseStateOf(repo, view, bases);
  const { state, conflicts } = merge3(base, stateOf(repo, view, a), stateOf(repo, view, b));
  return { state, conflicts, bases, base };
}

export function versionId(view, parents, batches, adds, dels) {
  return 'v' + sha(canonical({ view, parents, batches, adds, dels })).slice(0, 16);
}

// Create a merge version with certificate, journaled HEAD update.
export function mergeVersions(repo, view, a, b) {
  const { state, conflicts, bases, base } = mergeStates(repo, view, a, b);
  if (conflicts.length > 0) {
    throw err('E_CONFLICT', `merge of ${a} and ${b} has ${conflicts.length} key conflict(s)`, {
      view, a, b, conflicts,
    });
  }
  const parents = [a, b].sort();
  const { adds, dels } = diffStates(base, state);
  const id = versionId(view, parents, [], adds, dels);
  const version = { id, view, parents, batches: [], adds, dels, state };
  if (!repo.hasVersion(view, id)) repo.saveVersion(version);
  const heads = repo.getHeads(view);
  if (heads.includes(a) || heads.includes(b)) {
    const next = heads.filter((h) => h !== a && h !== b);
    if (!next.includes(id)) next.push(id);
    repo.commitHeads(view, heads, next.sort(), { merge: id });
  }
  return { version, bases, heads: repo.getHeads(view) };
}

// State explained by a version's certificate, recomputed from its parents and
// batches. Used by lincheck to verify certificates against serial replay.
// Covers plain commits, multi-parent commits and pure merge versions
// (a merge version is simply a version with several parents and no batches).
export function expectedStateOk(repo, view, v) {
  const base = mergedParentState(repo, view, v.parents);
  if (base.conflicts) return { ok: false, reason: 'merge-conflict', conflicts: base.conflicts };
  const ops = v.batches.flatMap((bid) => repo.getBatch(bid).ops);
  const state = applyOps(base.state, ops);
  return deepEq(state, v.state) ? { ok: true } : { ok: false, reason: 'state-mismatch' };
}

// Base state over 0..n parents: empty, the parent's state, or the pairwise
// three-way merge chain (same order as commit: sorted parent ids).
export function mergedParentState(repo, view, parents) {
  if (parents.length === 0) return { state: {} };
  let acc = stateOf(repo, view, parents[0]);
  for (const p of parents.slice(1)) {
    const m = mergeStates(repo, view, parents[0], p);
    const r = merge3(m.base, acc, stateOf(repo, view, p));
    if (r.conflicts.length > 0) return { conflicts: r.conflicts };
    acc = r.state;
  }
  return { state: acc };
}
