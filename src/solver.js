// Exact assignment optimizer.
//
// Each carrier may be unassigned or assigned to at most one tool window.
// Eligibility: same op, and the window has not fully ended before the carrier
// is ready (windowEnd >= carrier.eventTs). Assigning a carrier consumes `qty`
// of the window's hard capacity budget; remaining capacity may never go
// negative. Objective is lexicographic: maximize (totalScore, assignedCount).
// All optimal solutions ("ties") are enumerated and returned in a
// deterministic canonical order (assignments sorted by due, lot, carrier).

export const DEFAULT_MAX_SOLUTIONS = 5000;

export function compareCarriers(a, b) {
  if (a.due !== b.due) return a.due - b.due;
  if (a.lot !== b.lot) return a.lot < b.lot ? -1 : 1;
  if (a.carrier !== b.carrier) return a.carrier < b.carrier ? -1 : 1;
  return 0;
}

export function isEligible(carrier, window) {
  return carrier.op === window.op && window.windowEnd >= carrier.eventTs;
}

function compareWindows(a, b) {
  if (a.tool !== b.tool) return a.tool < b.tool ? -1 : 1;
  if (a.windowStart !== b.windowStart) return a.windowStart - b.windowStart;
  return a.windowEnd - b.windowEnd;
}

export function solveAll({ carriers, windows, scoreOf, maxSolutions = DEFAULT_MAX_SOLUTIONS }) {
  const orderedCarriers = [...carriers].sort(compareCarriers);
  const orderedWindows = [...windows].sort(compareWindows);
  const n = orderedCarriers.length;
  const scores = orderedCarriers.map((c) => scoreOf(c.lot) ?? 0);

  const suffixPosScore = new Array(n + 1).fill(0);
  const suffixCount = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    suffixPosScore[i] = suffixPosScore[i + 1] + Math.max(0, scores[i]);
    suffixCount[i] = suffixCount[i + 1] + 1;
  }

  const remaining = orderedWindows.map((w) => w.cap);
  const eligible = orderedCarriers.map((c) => {
    const list = [];
    for (let j = 0; j < orderedWindows.length; j += 1) {
      if (isEligible(c, orderedWindows[j])) list.push(j);
    }
    return list;
  });

  let best = null;
  let bestPicks = [];
  let truncated = false;
  const current = new Array(n).fill(-1);

  function dfs(i, score, count) {
    if (best !== null) {
      const scoreBound = score + suffixPosScore[i];
      if (scoreBound < best.score) return;
      if (scoreBound === best.score && count + suffixCount[i] < best.count) return;
    }
    if (i === n) {
      if (best === null || score > best.score || (score === best.score && count > best.count)) {
        best = { score, count };
        bestPicks = [];
        truncated = false;
      }
      if (score === best.score && count === best.count) {
        if (bestPicks.length >= maxSolutions) {
          truncated = true;
          return;
        }
        bestPicks.push(current.slice());
      }
      return;
    }
    current[i] = -1;
    dfs(i + 1, score, count);
    const carrier = orderedCarriers[i];
    for (const j of eligible[i]) {
      if (remaining[j] >= carrier.qty) {
        remaining[j] -= carrier.qty;
        current[i] = j;
        dfs(i + 1, score + scores[i], count + 1);
        remaining[j] += carrier.qty;
        current[i] = -1;
      }
    }
  }
  dfs(0, 0, 0);

  const solutions = bestPicks.map((picks) => {
    const assignments = [];
    const undispatched = [];
    for (let i = 0; i < n; i += 1) {
      const carrier = orderedCarriers[i];
      if (picks[i] < 0) {
        undispatched.push(carrier.carrier);
      } else {
        const window = orderedWindows[picks[i]];
        assignments.push({
          carrier: carrier.carrier,
          lot: carrier.lot,
          op: carrier.op,
          qty: carrier.qty,
          due: carrier.due,
          score: scores[i],
          tool: window.tool,
          windowStart: window.windowStart,
          windowEnd: window.windowEnd,
        });
      }
    }
    return { assignments, undispatched };
  });

  solutions.sort((a, b) => {
    const sa = JSON.stringify(a.assignments);
    const sb = JSON.stringify(b.assignments);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });

  return {
    objective: best === null ? { score: 0, count: 0 } : best,
    truncated,
    solutions,
  };
}
