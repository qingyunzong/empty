// Independent brute-force enumerator used to cross-check the solver.
// Enumerates every (machine, tool, start) combination for every operation.
export function bruteForce(instance) {
  const intervals = new Map(); // resource key -> [[s,e)]
  const toolLoad = new Map(instance.tools.map((t) => [t.id, 0]));
  const toolLife = new Map(instance.tools.map((t) => [t.id, t.life]));
  let best = Infinity;

  const overlaps = (key, s, e) => {
    const list = intervals.get(key) ?? [];
    return list.some(([a, b]) => s < b && a < e);
  };
  const push = (key, s, e) => {
    if (!intervals.has(key)) intervals.set(key, []);
    intervals.get(key).push([s, e]);
  };
  const pop = (key) => intervals.get(key).pop();

  function dfs(idx, acc) {
    if (acc >= best) return;
    if (idx === instance.operations.length) {
      best = acc;
      return;
    }
    const op = instance.operations[idx];
    for (let s = 0; s + op.duration <= instance.horizon; s += 1) {
      const e = s + op.duration;
      const tard = Math.max(0, e - op.due);
      for (const m of op.machines) {
        if (overlaps(`m:${m}`, s, e)) continue;
        for (const t of op.tools) {
          if (toolLoad.get(t) + op.minutes > toolLife.get(t)) continue;
          if (op.fixture && overlaps(`f:${op.fixture}`, s, e)) continue;
          push(`m:${m}`, s, e);
          if (op.fixture) push(`f:${op.fixture}`, s, e);
          toolLoad.set(t, toolLoad.get(t) + op.minutes);
          dfs(idx + 1, acc + tard);
          toolLoad.set(t, toolLoad.get(t) - op.minutes);
          if (op.fixture) pop(`f:${op.fixture}`);
          pop(`m:${m}`);
        }
      }
    }
  }
  dfs(0, 0);
  return { feasible: best < Infinity, bestTardiness: best < Infinity ? best : null };
}
