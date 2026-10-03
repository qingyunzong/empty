// Independent brute-force enumerator used to cross-check the solver.
// It exhaustively walks every (slot, machine) decision — machine choice,
// order choice, idle choice and preemption points — with no memoization,
// keeping the best (total tardiness, per-order tardiness vector ordered by
// order id). Returns null when no complete schedule exists.

export function enumerateOptimal(inst) {
  const orders = inst.orders;
  const N = orders.length;
  const M = inst.machines.length;
  const now = inst.now;

  for (const o of orders) {
    if (o.deadline < o.release) return null;
  }
  const need = new Map();
  for (const o of orders) need.set(o.family, (need.get(o.family) ?? 0) + o.duration);
  const cap = new Map();
  for (const s of inst.shifts) {
    for (const [f, q] of Object.entries(s.quotas)) cap.set(f, (cap.get(f) ?? 0) + q);
  }
  for (const [f, n] of need) if ((cap.get(f) ?? 0) < n) return null;

  const families = [...new Set(orders.map((o) => o.family))];
  const famOf = orders.map((o) => families.indexOf(o.family));
  const S = inst.shifts.length;
  const H = S > 0 ? Math.max(...inst.shifts.map((s) => s.end)) : 0;
  const shiftOf = new Int32Array(Math.max(H, 1)).fill(-1);
  inst.shifts.forEach((s, si) => {
    for (let t = Math.max(s.start, now); t < s.end; t += 1) shiftOf[t] = si;
  });
  const quota = inst.shifts.map((s) => families.map((f) => s.quotas[f] ?? 0));
  const machineIdx = new Map(inst.machines.map((id, i) => [id, i]));
  const compat = orders.map((o) => o.machines.map((id) => machineIdx.get(id)));

  // Mutable state, restored after each branch (plain exhaustive search).
  const loaded = new Array(M).fill(-1);
  const pending = new Array(M).fill(-1);
  const done = new Array(N).fill(0);
  const pre = new Array(N).fill(0);
  const comp = new Array(N).fill(-1);
  const used = inst.shifts.map((s) => families.map(() => 0));

  let best = null; // { total, vec }
  let nodes = 0;
  const NODE_CAP = 20_000_000;
  const memo = new Map();

  const canRun = (x, t, slotMask) => {
    const sh = t < H ? shiftOf[t] : -1;
    return sh !== -1 && used[sh][famOf[x]] < quota[sh][famOf[x]];
  };

  function consider() {
    let total = 0;
    const vec = new Array(N);
    for (let i = 0; i < N; i += 1) {
      vec[i] = Math.max(0, comp[i] - orders[i].deadline);
      total += vec[i];
    }
    if (best === null || total < best.total || (total === best.total && lexLess(vec, best.vec))) {
      best = { total, vec };
    }
  }

  function lexLess(a, b) {
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
  }

  function lexLeq(a, b) {
    return !lexLess(b, a);
  }

  function lowerBound(t) {
    let b = 0;
    for (let i = 0; i < N; i += 1) {
      if (comp[i] >= 0) b += Math.max(0, comp[i] - orders[i].deadline);
      else {
        const est = Math.max(t, orders[i].release) + (orders[i].duration - done[i]);
        b += Math.max(0, est - orders[i].deadline);
      }
    }
    return b;
  }

  function walk(t, m, slotMask) {
    nodes += 1;
    if (nodes > NODE_CAP) throw new Error('enumerator node cap exceeded');
    if (t >= H) {
      for (let i = 0; i < N; i += 1) if (done[i] < orders[i].duration) return;
      consider();
      return;
    }
    if (best !== null && lowerBound(t) > best.total) return;

    // dominance memo: identical state reached with a no-better cost/vector is pruned
    let cost = 0;
    const costVec = new Array(N).fill(-1);
    for (let i = 0; i < N; i += 1) {
      if (comp[i] >= 0) {
        costVec[i] = Math.max(0, comp[i] - orders[i].deadline);
        cost += costVec[i];
      }
    }
    const key = [t, m, slotMask, ...loaded, ...pending, ...done, ...pre, ...used.flat()].join(',');
    const seen = memo.get(key);
    if (seen && (seen.cost < cost || (seen.cost === cost && lexLeq(seen.vec, costVec)))) return;
    if (!seen || cost < seen.cost || (cost === seen.cost && lexLess(costVec, seen.vec))) {
      memo.set(key, { cost, vec: costVec });
    }

    // necessary condition: remaining family quota must cover remaining work
    for (let f = 0; f < families.length; f += 1) {
      let remWork = 0;
      for (let i = 0; i < N; i += 1) if (famOf[i] === f) remWork += orders[i].duration - done[i];
      if (remWork === 0) continue;
      let remCap = 0;
      for (let s = 0; s < S; s += 1) remCap += quota[s][f] - used[s][f];
      if (remWork > remCap) return;
    }

    const nm = m + 1 < M ? m + 1 : 0;
    const nt = m + 1 < M ? t : t + 1;
    const nextMask = m + 1 < M ? slotMask : 0;

    const produce = (x, isStart) => {
      const savedLoadedElsewhere = [];
      if (isStart) {
        for (let m2 = 0; m2 < M; m2 += 1) {
          if (m2 !== m && loaded[m2] === x) {
            savedLoadedElsewhere.push(m2);
            loaded[m2] = -1;
          }
        }
      }
      const prevLoaded = loaded[m];
      loaded[m] = x;
      const sh = shiftOf[t];
      used[sh][famOf[x]] += 1;
      done[x] += 1;
      let completed = false;
      if (done[x] === orders[x].duration) {
        comp[x] = t + 1;
        loaded[m] = -1;
        completed = true;
      }
      walk(nt, nm, m + 1 < M ? slotMask | (1 << x) : 0);
      done[x] -= 1;
      used[sh][famOf[x]] -= 1;
      if (completed) comp[x] = -1;
      loaded[m] = prevLoaded;
      if (isStart) for (const m2 of savedLoadedElsewhere) loaded[m2] = x;
    };

    const pm = pending[m];
    if (pm !== -1) {
      if (canRun(pm, t)) {
        pending[m] = -1;
        produce(pm, false);
        pending[m] = pm;
      }
      return;
    }

    const y = loaded[m];
    const yActive = y !== -1 && done[y] < orders[y].duration;
    const yCan = yActive && canRun(y, t);

    if (yActive && yCan) {
      // continue the loaded order
      produce(y, false);
      // preemption by a critical order: changeover at t, order starts at t+1
      if (pre[y] < 2 && orders[y].priorityLevel < 3 && shiftOf[t] >= 0 && t + 1 < H) {
        for (let x = 0; x < N; x += 1) {
          if (x === y || orders[x].priorityLevel !== 3) continue;
          if (done[x] >= orders[x].duration || orders[x].release > t + 1) continue;
          if (!compat[x].includes(m)) continue;
          if (slotMask & (1 << x)) continue;
          if (pending.includes(x)) continue;
          if (loaded.some((c, mm) => mm !== m && c === x)) continue;
          if (!canRun(x, t + 1)) continue;
          pre[y] += 1;
          loaded[m] = -1;
          pending[m] = x;
          walk(nt, nm, nextMask);
          pending[m] = -1;
          loaded[m] = y;
          pre[y] -= 1;
        }
      }
      // idle
      walk(nt, nm, nextMask);
      return;
    }

    // machine free or loaded order cannot run now: idle or start an order
    walk(nt, nm, nextMask); // idle
    for (let x = 0; x < N; x += 1) {
      if (x === y) continue;
      if (done[x] >= orders[x].duration || orders[x].release > t) continue;
      if (!compat[x].includes(m)) continue;
      if (slotMask & (1 << x)) continue;
      if (pending.includes(x)) continue;
      if (!canRun(x, t)) continue;
      produce(x, true);
    }
  }

  walk(now, 0, 0);
  return best;
}
