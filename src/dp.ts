import { Instance, Solution } from "./types";
import { travelMatrix } from "./instance";

interface Label {
  time: number;
  dist: number;
}

/**
 * Independent exact solver based on subset DP with Pareto labels.
 * State (mask, last) keeps non-dominated (departureTime, travelDistance) labels;
 * a label dominates another when it is no worse in both coordinates.
 * Used to cross-check the branch-and-bound solver.
 */
export function solveDp(instance: Instance): Solution {
  const { stations, depot, timeLimit } = instance;
  const n = stations.length;
  const d = travelMatrix(instance);
  const size = 1 << n;

  const maskProfit = new Array<number>(size).fill(0);
  for (let mask = 1; mask < size; mask++) {
    const bit = mask & -mask;
    const idx = 31 - Math.clz32(bit);
    maskProfit[mask] = maskProfit[mask ^ bit]! + stations[idx]!.profit;
  }

  // labels[mask][last] = Pareto frontier of {time, dist}
  const labels: (Label[] | null)[][] = Array.from({ length: size }, () =>
    new Array<Label[] | null>(n).fill(null),
  );
  labels[1 << depot]![depot] = [{ time: 0, dist: 0 }];

  function insert(mask: number, last: number, cand: Label): void {
    let frontier = labels[mask]![last];
    if (frontier == null) {
      frontier = [];
      labels[mask]![last] = frontier;
    }
    for (const l of frontier) {
      if (l.time <= cand.time && l.dist <= cand.dist) return; // dominated
    }
    labels[mask]![last] = frontier.filter((l) => !(cand.time <= l.time && cand.dist <= l.dist));
    labels[mask]![last]!.push(cand);
  }

  for (let mask = 1; mask < size; mask++) {
    if ((mask & (1 << depot)) === 0) continue;
    for (let last = 0; last < n; last++) {
      const frontier = labels[mask]![last];
      if (!frontier) continue;
      for (const label of frontier) {
        for (let j = 0; j < n; j++) {
          if (j === depot || (mask & (1 << j)) !== 0) continue;
          const st = stations[j]!;
          const arrival = label.time + d[last]![j]!;
          const start = Math.max(arrival, st.open);
          if (start > st.close) continue;
          const departure = start + st.service;
          if (departure + d[j]![depot]! > timeLimit) continue;
          insert(mask | (1 << j), j, { time: departure, dist: label.dist + d[last]![j]! });
        }
      }
    }
  }

  let bestProfit = 0;
  let bestDistance = d[depot]![depot]!; // empty route
  let bestMask = 1 << depot;
  let bestLast = depot;
  let bestLabel: Label = { time: 0, dist: 0 };
  for (let mask = 1; mask < size; mask++) {
    if ((mask & (1 << depot)) === 0) continue;
    const profit = maskProfit[mask]!;
    if (profit < bestProfit) continue;
    for (let last = 0; last < n; last++) {
      const frontier = labels[mask]![last];
      if (!frontier) continue;
      for (const label of frontier) {
        const totalDist = label.dist + d[last]![depot]!;
        if (label.time + d[last]![depot]! > timeLimit) continue;
        if (profit > bestProfit || (profit === bestProfit && totalDist < bestDistance)) {
          bestProfit = profit;
          bestDistance = totalDist;
          bestMask = mask;
          bestLast = last;
          bestLabel = label;
        }
      }
    }
  }

  // reconstruct route by walking predecessors backwards
  const routeIdx: number[] = [];
  let mask = bestMask;
  let last = bestLast;
  let target = bestLabel;
  while (mask !== (1 << depot)) {
    routeIdx.push(last);
    const prevMask = mask ^ (1 << last);
    let found = false;
    for (let prev = 0; prev < n && !found; prev++) {
      if ((prevMask & (1 << prev)) === 0) continue;
      const frontier = labels[prevMask]![prev];
      if (!frontier) continue;
      for (const l of frontier) {
        const st = stations[last]!;
        const start = Math.max(l.time + d[prev]![last]!, st.open);
        const departure = start + st.service;
        if (
          departure === target.time &&
          l.dist + d[prev]![last]! === target.dist &&
          start <= st.close
        ) {
          mask = prevMask;
          last = prev;
          target = l;
          found = true;
          break;
        }
      }
    }
    if (!found) throw new Error("dp reconstruction failed");
  }
  routeIdx.reverse();

  const byId = (i: number) => stations[i]!.id;
  return {
    route: routeIdx.map(byId),
    profit: bestProfit,
    distance: bestDistance,
    totalTime: bestLabel.time + d[bestLast]![depot]!,
  };
}
