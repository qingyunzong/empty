import { validateOps, applyOps, diffStates, effectsOf } from './model.js';
import { HbGraph } from './hb.js';
import { mergedParentState, versionId } from './merge.js';
import { canonical, sha, deepEq } from './util.js';
import { err } from './errors.js';

const ID_RE = /^[\w.-]+$/;

function normalizeBatch(input) {
  if (!input || typeof input !== 'object') throw err('E_INVALID', 'batch must be an object');
  const b = { ...input };
  validateOps(b.ops);
  if (b.pid !== undefined && (typeof b.pid !== 'string' || !ID_RE.test(b.pid)))
    throw err('E_INVALID', 'batch.pid must be an id string');
  b.pid ??= 'anon';
  b.deps ??= [];
  if (!Array.isArray(b.deps)) throw err('E_INVALID', 'batch.deps must be an array');
  if (b.clock !== undefined && (!Number.isInteger(b.clock) || b.clock < 0))
    throw err('E_INVALID', 'batch.clock must be a non-negative integer');
  b.view ??= 'main';
  if (b.id === undefined) b.id = 'b' + sha(canonical({ ...b, id: undefined })).slice(0, 16);
  if (!ID_RE.test(b.id)) throw err('E_INVALID', `bad batch id ${b.id}`);
  return b;
}

// Commit one observation batch. Write order is crash-safe:
//   batch object -> version certificate -> journal -> HEAD -> drop journal.
// opts.hooks.afterHeads lets tests inject a crash after the parent-pointer
// (HEAD) update, before the journal is dropped and the commit is acked.
export function commit(repo, input, opts = {}) {
  const unlock = repo.lock();
  try {
    const batch = normalizeBatch(input);
    const view = batch.view;

    // Idempotent retry: an acknowledged (or crash-lost-ack) commit replays.
    if (repo.hasBatch(batch.id)) {
      const v = repo.listVersions(view).find((x) => x.batches.includes(batch.id));
      if (v) {
        return { version: v.id, view, heads: repo.getHeads(view), conflicts: detectConflicts(repo, batch), duplicate: true };
      }
    }

    // Explicit dependencies must exist: orphan batches are rejected.
    const missing = batch.deps.filter((d) => !repo.hasBatch(d));
    if (missing.length > 0) throw err('E_ORPHAN', `unknown dependency batches: ${missing.join(', ')}`, { missing });

    // Logical clock: keep the client's, else extend this process's timeline.
    if (batch.clock === undefined) {
      const mine = repo.listBatches().filter((x) => x.pid === batch.pid);
      batch.clock = mine.reduce((m, x) => Math.max(m, x.clock ?? 0), 0) + 1;
    }

    // Parent selection: explicit parent(s), else the unique current head.
    const heads = repo.getHeads(view);
    let parents;
    const explicit = batch.parents ?? (batch.parent !== undefined ? [batch.parent] : null);
    if (explicit) {
      parents = explicit.map((p) => repo.resolveVersion(view, p));
    } else if (heads.length === 0) {
      parents = [];
    } else if (heads.length === 1) {
      parents = heads;
    } else {
      throw err('E_BAD_PARENT', `view ${view} has ${heads.length} heads; batch must name a parent`, { heads });
    }

    parents = [...parents].sort();

    // Naming a parent version means the committer observed it: its batches
    // become happens-before predecessors of this batch.
    const inherited = parents.flatMap((p) => repo.getVersion(view, p).batches);
    batch.deps = [...new Set([...batch.deps, ...inherited])];

    const baseR = mergedParentState(repo, view, parents);
    if (baseR.conflicts)
      throw err('E_CONFLICT', 'parent states conflict', { parents, conflicts: baseR.conflicts });
    const base = baseR.state;
    const state = applyOps(base, batch.ops);
    const { adds, dels } = diffStates(base, state);
    const vid = versionId(view, [...parents].sort(), [batch.id], adds, dels);
    const version = { id: vid, view, parents: [...parents].sort(), batches: [batch.id], adds, dels, state };

    repo.saveBatch(batch);
    if (!repo.hasVersion(view, vid)) repo.saveVersion(version);
    const nextHeads = [...heads.filter((h) => !parents.includes(h)), vid].sort();
    const jfile = repo.beginHeads(view, heads, nextHeads, { batch: batch.id, version: vid });
    repo.applyHeads(view, nextHeads);
    opts.hooks?.afterHeads?.(); // crash window: parent pointer moved, ack not sent
    repo.endHeads(jfile);

    return { version: vid, view, heads: nextHeads, conflicts: detectConflicts(repo, batch) };
  } finally {
    unlock();
  }
}

// Concurrent-incomparable batches touching the same key with different
// effects are reported as conflicts; we never silently pick a winner.
export function detectConflicts(repo, batch) {
  const all = repo.listBatches(batch.view ?? 'main');
  const hb = new HbGraph(all);
  const mine = effectsOf(batch);
  const conflicts = [];
  for (const other of all) {
    if (other.id === batch.id) continue;
    if (hb.compare(batch.id, other.id) !== 'concurrent') continue;
    const theirs = effectsOf(other);
    for (const [key, ours] of Object.entries(mine)) {
      if (theirs[key] !== undefined && !deepEq(ours, theirs[key])) {
        conflicts.push({ key, other: other.id, ours, theirs: theirs[key] });
      }
    }
  }
  return conflicts;
}
