// Independent brute-force enumerator used ONLY by the tests.
//
// It exhaustively enumerates, slot by slot, every combination of machine
// actions (produce any runnable order / preempt with a critical order via a
// changeover slot / idle), i.e. every machine assignment, every segment
// order and every preemption point. The only prunes applied are valid
// lower-bound/dominance cuts that cannot remove an optimal schedule:
//   - a tardiness lower bound against the incumbent,
//   - per-order remaining-capacity feasibility,
//   - idling is skipped when it is strictly dominated (a loaded, runnable
//     order idles; an empty machine idles although every remaining order is
//     already released),
//   - time jumps forward when no machine can act.
// Returns { feasible, tardiness, completion } using the same tie-break as the
// solver: lexicographically smallest completion vector with orders sorted by id.

export function bruteForceBest(inst, { nodeBudget = 5_000_000 } = {}) {
  const M = inst.machines.length;
  const N = inst.orders.length;
  const H = inst.horizon;
  if (N === 0) return { feasible: true, tardiness: 0, completion: [] };

  const shiftOf = new Int32Array(Math.max(H, 1)).fill(-1);
  inst.shifts.forEach((s, si) => { for (let t = s.start; t < s.end; t++) shiftOf[t] = si; });
  const famOf = inst.orders.map((o) => inst.families.indexOf(o.family));
  const quota = inst.shifts.map((s) => inst.families.map((f) => s.quotas[f] ?? 0));
  const rem = inst.orders.map((o) => o.duration);
  const pre = new Array(N).fill(0);
  const loaded = new Array(M).fill(-1);
  const must = new Array(M).fill(-1);
  const comp = new Array(N).fill(-1);
  const rel = inst.orders.map((o) => o.release);
  const assigned = new Array(N).fill(-1); // each order runs on exactly one machine
  const NO_NOW = new Set();               // empty "producing this slot" set
  const ddl = inst.orders.map((o) => o.deadline);
  const crit = inst.orders.map((o) => o.critical);
  const onMachine = inst.orders.map((o) => o.machines);

  const idOrder = [...Array(N).keys()].sort((a, b) => (inst.orders[a].id < inst.orders[b].id ? -1 : 1));
  const lexLess = (a, b) => {
    for (const i of idOrder) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };
  const events = [...new Set([...rel, ...inst.shifts.map((s) => s.start)])]
    .filter((x) => x > 0).sort((a, b) => a - b);

  let tard = 0;
  let done = 0;
  let nodes = 0;
  let best = null;

  const canProd = (x, m, t, now = NO_NOW) => {
    if (t >= H || rem[x] === 0 || rel[x] > t || !onMachine[x].includes(m)) return false;
    if (assigned[x] !== -1 && assigned[x] !== m) return false;
    if (now.has(x)) return false; // an order cannot run on two machines in one slot
    const sh = shiftOf[t];
    return sh >= 0 && quota[sh][famOf[x]] > 0;
  };

  function produce(m, x, t, now) {
    if (assigned[x] === -1) assigned[x] = m;
    now.add(x);
    quota[shiftOf[t]][famOf[x]]--;
    rem[x]--;
    if (rem[x] === 0) {
      comp[x] = t + 1;
      const late = t + 1 - ddl[x];
      if (late > 0) tard += late;
      done++;
      loaded[m] = -1;
    } else {
      loaded[m] = x;
    }
  }
  function unproduce(m, x, t, prevLoaded, wasUnassigned, now) {
    if (rem[x] === 0) {
      done--;
      const late = t + 1 - ddl[x];
      if (late > 0) tard -= late;
      comp[x] = -1;
    }
    rem[x]++;
    quota[shiftOf[t]][famOf[x]]++;
    now.delete(x);
    if (wasUnassigned) assigned[x] = -1;
    loaded[m] = prevLoaded;
  }

  function tryProduce(m, x, t, now, cont) {
    if (!canProd(x, m, t, now)) return;
    const prevLoaded = loaded[m];
    const wasUnassigned = assigned[x] === -1;
    produce(m, x, t, now);
    cont();
    unproduce(m, x, t, prevLoaded, wasUnassigned, now);
  }

  function expandMachine(m, t, now, cont) {
    if (must[m] >= 0) {
      const x = must[m];
      if (canProd(x, m, t, now)) {
        must[m] = -1;
        tryProduce(m, x, t, now, cont);
        must[m] = x;
      }
      return;
    }
    const b = loaded[m];
    if (b >= 0) {
      tryProduce(m, b, t, now, cont);
      if (!crit[b] && pre[b] < 2) {
        for (let c = 0; c < N; c++) {
          if (!crit[c] || rem[c] === 0 || !onMachine[c].includes(m)) continue;
          if (assigned[c] !== -1 && assigned[c] !== m) continue;
          if (!canProd(c, m, t + 1)) continue;
          pre[b]++;
          loaded[m] = c;
          must[m] = c;
          cont();
          must[m] = -1;
          loaded[m] = b;
          pre[b]--;
        }
      }
      // Idle is always allowed: shared quota may be needed by another machine.
      cont();
      return;
    }
    for (let x = 0; x < N; x++) tryProduce(m, x, t, now, cont);
    cont(); // idle
  }

  function rec(m, t, now) {
    if (m === M) { dfs(t + 1); return; }
    expandMachine(m, t, now, () => rec(m + 1, t, now));
  }

  function dfs(t) {
    if (++nodes > nodeBudget) throw new Error(`brute force exceeded node budget (${nodeBudget})`);
    if (done === N) {
      if (!best || tard < best.tardiness || (tard === best.tardiness && lexLess(comp, best.completion))) {
        best = { tardiness: tard, completion: comp.slice() };
      }
      return;
    }
    if (t >= H) return;
    if (best) {
      let bound = tard;
      for (let i = 0; i < N; i++) {
        if (rem[i] > 0) {
          const c = t + rem[i];
          if (c > ddl[i]) bound += c - ddl[i];
        }
      }
      if (bound > best.tardiness) return;
    }
    for (let i = 0; i < N; i++) {
      if (rem[i] === 0) continue;
      let need = rem[i];
      for (let s = Math.max(t, rel[i]); s < H && need > 0; s++) {
        const sh = shiftOf[s];
        if (sh >= 0 && quota[sh][famOf[i]] > 0) need--;
      }
      if (need > 0) return;
    }
    // If no machine can do anything but idle, jump to the next event.
    let anyAction = false;
    for (let m = 0; m < M && !anyAction; m++) {
      if (must[m] >= 0) { anyAction = true; break; }
      const b = loaded[m];
      if (b >= 0) {
        if (canProd(b, m, t)) anyAction = true;
        else if (!crit[b] && pre[b] < 2) {
          for (let c = 0; c < N && !anyAction; c++) {
            if (crit[c] && rem[c] > 0 && onMachine[c].includes(m) && canProd(c, m, t + 1)) anyAction = true;
          }
        }
      } else {
        for (let x = 0; x < N && !anyAction; x++) if (canProd(x, m, t)) anyAction = true;
      }
    }
    if (!anyAction) {
      let next = Infinity;
      for (const e of events) if (e > t) { next = e; break; }
      if (next === Infinity) return;
      dfs(Math.min(next, H));
      return;
    }
    rec(0, t, new Set());
  }

  dfs(0);
  if (!best) return { feasible: false, tardiness: null, completion: null };
  return { feasible: true, tardiness: best.tardiness, completion: best.completion };
}
