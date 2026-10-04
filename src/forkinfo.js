import { ancestorSet, lcaSet } from './merge.js';

// Describe the version DAG of a view: heads, fork points, and — for replaying
// only divergent branches — the per-head replay set of versions/batches that
// are not explained by any common ancestor of the heads.
export function forkinfo(repo, view) {
  const versions = repo.listVersions(view);
  const heads = repo.getHeads(view);
  const children = new Map(versions.map((v) => [v.id, []]));
  for (const v of versions) for (const p of v.parents) children.get(p)?.push(v.id);
  const forks = [...children.entries()].filter(([, c]) => c.length > 1).map(([id]) => id).sort();

  let lcas = [];
  if (heads.length > 1) {
    lcas = heads.slice(1).reduce((acc, h) => {
      const out = new Set();
      for (const a of acc) for (const x of lcaSet(repo, view, a, h)) out.add(x);
      return [...out];
    }, [heads[0]]);
  }

  const shared = new Set();
  for (const l of lcas) for (const x of ancestorSet(repo, view, l)) shared.add(x);

  const byId = new Map(versions.map((v) => [v.id, v]));
  const branches = {};
  for (const h of heads) {
    const replay = [...ancestorSet(repo, view, h)].filter((x) => !shared.has(x));
    // topological order: parents before children
    replay.sort((a, b) => depth(byId, a) - depth(byId, b));
    branches[h] = {
      replay,
      batches: replay.flatMap((id) => byId.get(id).batches),
    };
  }

  return {
    view,
    heads,
    versionCount: versions.length,
    forks,
    lcas,
    branches,
  };
}

function depth(byId, id) {
  let d = 0;
  let cur = byId.get(id);
  const seen = new Set();
  while (cur && cur.parents.length > 0 && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.parents[0]);
    d++;
  }
  return d;
}
