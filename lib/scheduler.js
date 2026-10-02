'use strict';

function lexLess(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

// Exact placement: choose the subset of candidates that fits `capacity` and
// maximizes total retention weight. Ties: smaller total size, then
// lexicographically smallest sorted id set (deterministic).
function selectPlacement(candidates, capacity) {
  const items = candidates
    .filter((c) => c.size > 0 && c.size <= capacity && c.retention > 0)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = items.length;
  const suffix = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + items[i].retention;

  let best = { weight: 0, size: 0, ids: [] };
  const chosen = [];

  function dfs(i, size, weight) {
    const ids = [...chosen].sort();
    if (
      weight > best.weight ||
      (weight === best.weight && size < best.size) ||
      (weight === best.weight && size === best.size && lexLess(ids, best.ids))
    ) {
      best = { weight, size, ids };
    }
    if (i >= n) return;
    if (weight + suffix[i] < best.weight) return;
    if (size + items[i].size <= capacity) {
      chosen.push(items[i].id);
      dfs(i + 1, size + items[i].size, weight + items[i].retention);
      chosen.pop();
    }
    dfs(i + 1, size, weight);
  }

  dfs(0, 0, 0);
  return best;
}

// Quota fairness: rank requesters by completed-byte deficit relative to their
// quota weight; a requester whose oldest wait exceeds the wait cap is boosted
// above all non-exceeded requesters.
function rankRequesters(requesters) {
  const totalWeight = requesters.reduce((s, r) => s + r.weight, 0) || 1;
  const totalCompleted = requesters.reduce((s, r) => s + r.completedBytes, 0);
  const scored = requesters.map((r) => ({
    name: r.name,
    deficit: (r.weight / totalWeight) * totalCompleted - r.completedBytes,
    waitExceeded: Boolean(r.waitExceeded),
    longestWait: r.longestWait || 0,
  }));
  scored.sort((a, b) => {
    if (a.waitExceeded !== b.waitExceeded) return a.waitExceeded ? -1 : 1;
    if (a.waitExceeded && b.waitExceeded && a.longestWait !== b.longestWait) {
      return b.longestWait - a.longestWait;
    }
    if (a.deficit !== b.deficit) return b.deficit - a.deficit;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return scored.map((s) => s.name);
}

// Split one tick of bandwidth equally among active restores (in priority
// order), redistributing leftover from objects that need less than their share.
function allocateBandwidth(active, bandwidth) {
  const alloc = new Map(active.map((o) => [o.id, 0]));
  let budget = bandwidth;
  let pending = active.filter((o) => o.remaining > 0);
  while (budget > 0 && pending.length > 0) {
    const per = Math.max(1, Math.floor(budget / pending.length));
    const still = [];
    let spent = 0;
    for (const o of pending) {
      if (budget <= 0) {
        still.push(o);
        continue;
      }
      const need = o.remaining - alloc.get(o.id);
      const give = Math.min(per, need, budget);
      if (give > 0) {
        alloc.set(o.id, alloc.get(o.id) + give);
        budget -= give;
        spent += give;
      }
      if (alloc.get(o.id) < o.remaining) still.push(o);
    }
    if (spent === 0) break;
    pending = still;
  }
  return alloc;
}

module.exports = { selectPlacement, rankRequesters, allocateBandwidth };
