// Interval scheduling with switch costs.
// Objective lexicographic:
//   1. maximize total science value
//   2. minimize max PI exposure deficit (fairness: 最小化最大缺口)
//   3. minimize sorted target-id list (deterministic tie-break by target ID)
// Exact branch-and-bound over candidates sorted by window end; confirmed
// observations are fixed blocks that every candidate timeline must respect.

export function solveSchedule({ candidates, fixed = [], quotas = new Map(), pis = [] }) {
  const ordered = [...candidates].sort(
    (a, b) => a.end - b.end || a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const fixedActs = fixed.map((f) => ({ start: f.start, end: f.end, switch: f.switch ?? 0, id: f.id ?? '' }));

  const fixedExposure = new Map();
  for (const f of fixed) fixedExposure.set(f.pi, (fixedExposure.get(f.pi) ?? 0) + (f.end - f.start));

  const quotaOf = (pi) => (quotas instanceof Map ? quotas.get(pi) : quotas[pi]);

  const suffix = new Array(ordered.length + 1).fill(0);
  for (let i = ordered.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + Math.max(0, ordered[i].value);

  const selected = [];
  const exposure = new Map();
  let best = null;
  let bestSelection = [];

  function timelineFeasible(extra) {
    const acts = extra ? [...fixedActs, ...selected, extra] : [...fixedActs, ...selected];
    acts.sort(
      (a, b) => a.start - b.start || a.end - b.end || ((a.id ?? '') < (b.id ?? '') ? -1 : 1),
    );
    for (let i = 0; i + 1 < acts.length; i++) {
      if (acts[i].end + (acts[i + 1].switch ?? 0) > acts[i + 1].start) return false;
    }
    return true;
  }

  function quotaOk(cand) {
    const q = quotaOf(cand.pi);
    if (q == null) return true;
    const have = (fixedExposure.get(cand.pi) ?? 0) + (exposure.get(cand.pi) ?? 0);
    return have + (cand.end - cand.start) <= q;
  }

  function objectiveOf() {
    let value = 0;
    for (const s of selected) value += s.value;
    const totals = new Map(fixedExposure);
    for (const s of selected) totals.set(s.pi, (totals.get(s.pi) ?? 0) + (s.end - s.start));
    let maxExp = 0;
    for (const pi of pis) maxExp = Math.max(maxExp, totals.get(pi) ?? 0);
    let maxDeficit = 0;
    for (const pi of pis) maxDeficit = Math.max(maxDeficit, maxExp - (totals.get(pi) ?? 0));
    return { value, maxDeficit, ids: selected.map((s) => s.id).sort() };
  }

  function better(a, b) {
    if (a.value !== b.value) return a.value > b.value;
    if (a.maxDeficit !== b.maxDeficit) return a.maxDeficit < b.maxDeficit;
    const n = Math.min(a.ids.length, b.ids.length);
    for (let i = 0; i < n; i++) {
      if (a.ids[i] !== b.ids[i]) return a.ids[i] < b.ids[i];
    }
    return a.ids.length < b.ids.length;
  }

  function dfs(i, value) {
    if (best && value + suffix[i] < best.value) return;
    if (i === ordered.length) {
      const obj = objectiveOf();
      if (!best || better(obj, best)) {
        best = obj;
        bestSelection = [...selected];
      }
      return;
    }
    const cand = ordered[i];
    if (quotaOk(cand) && timelineFeasible(cand)) {
      selected.push(cand);
      exposure.set(cand.pi, (exposure.get(cand.pi) ?? 0) + (cand.end - cand.start));
      dfs(i + 1, value + cand.value);
      exposure.set(cand.pi, exposure.get(cand.pi) - (cand.end - cand.start));
      selected.pop();
    }
    dfs(i + 1, value);
  }

  dfs(0, 0);

  const totals = {};
  for (const [pi, v] of fixedExposure) totals[pi] = v;
  for (const s of bestSelection) totals[s.pi] = (totals[s.pi] ?? 0) + (s.end - s.start);

  return {
    selected: bestSelection,
    value: best ? best.value : 0,
    maxDeficit: best ? best.maxDeficit : 0,
    exposure: totals,
  };
}
