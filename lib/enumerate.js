'use strict';

// Brute-force enumeration of every reviewer assignment, used as the
// ground-truth cross-check (<=3 reviewers, 2 periods) and as the UNSAT proof.
function enumerateAssignments(entries, domains, reviewers) {
  const capacity = new Map(reviewers.map((r) => [r.id, r.capacity == null ? Infinity : r.capacity]));
  const load = new Map(reviewers.map((r) => [r.id, 0]));
  let explored = 0;
  let solutions = 0;
  const first = [];

  function dfs(i) {
    if (i === entries.length) {
      solutions += 1;
      return;
    }
    for (const rid of domains[i]) {
      explored += 1;
      if (load.get(rid) + entries[i].amount > capacity.get(rid)) continue;
      load.set(rid, load.get(rid) + entries[i].amount);
      if (solutions === 0) first[i] = rid;
      dfs(i + 1);
      if (solutions === 0) first[i] = null;
      load.set(rid, load.get(rid) - entries[i].amount);
    }
  }

  dfs(0);
  return { explored, solutions, first: solutions > 0 ? first : null };
}

module.exports = { enumerateAssignments };
