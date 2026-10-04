import { Instance, Solution } from "./types";
import { travelMatrix } from "./instance";

/**
 * Exact branch-and-bound solver for the orienteering problem with time windows.
 * Objective: maximize total profit; tie-break: minimize travel distance.
 * Route departs the depot at t=0 and must be back by timeLimit.
 */
export function solve(instance: Instance): Solution {
  const { stations, depot, timeLimit } = instance;
  const n = stations.length;
  const d = travelMatrix(instance);

  let bestProfit = -1;
  let bestDistance = Infinity;
  let bestRoute: number[] = [];

  function consider(routeIdx: number[], profit: number, distance: number): void {
    if (profit > bestProfit || (profit === bestProfit && distance < bestDistance)) {
      bestProfit = profit;
      bestDistance = distance;
      bestRoute = routeIdx.map((i) => stations[i]!.id);
    }
  }

  const route: number[] = [];

  function dfs(cur: number, visited: number, time: number, profit: number, dist: number, remaining: number): void {
    const backDist = dist + d[cur]![depot]!;
    const backTime = time + d[cur]![depot]!;
    if (backTime <= timeLimit) consider(route, profit, backDist);
    // upper bound on profit: collect everything still unvisited
    if (profit + remaining < bestProfit) return;
    // if we can only tie on profit, distance can no longer improve
    if (profit + remaining === bestProfit && backDist >= bestDistance) return;
    for (let j = 0; j < n; j++) {
      if (j === depot || (visited & (1 << j)) !== 0) continue;
      const st = stations[j]!;
      const arrival = time + d[cur]![j]!;
      const start = Math.max(arrival, st.open);
      if (start > st.close) continue;
      const departure = start + st.service;
      if (departure + d[j]![depot]! > timeLimit) continue;
      route.push(j);
      dfs(j, visited | (1 << j), departure, profit + st.profit, dist + d[cur]![j]!, remaining - st.profit);
      route.pop();
    }
  }

  const totalRemaining = stations.reduce((acc, s, i) => (i === depot ? acc : acc + s.profit), 0);
  dfs(depot, 1 << depot, 0, 0, 0, totalRemaining);

  return {
    route: bestRoute,
    profit: bestProfit,
    distance: bestDistance,
    totalTime: simulateTime(instance, bestRoute),
  };
}

/** Total elapsed time (travel + wait + service) for a route of station ids, back at the depot. */
export function simulateTime(instance: Instance, routeIds: number[]): number {
  const d = travelMatrix(instance);
  const byId = new Map(instance.stations.map((s, i) => [s.id, i]));
  let time = 0;
  let cur = instance.depot;
  for (const id of routeIds) {
    const j = byId.get(id);
    if (j === undefined) throw new Error(`unknown station id ${id}`);
    const st = instance.stations[j]!;
    time += d[cur]![j]!;
    if (time < st.open) time = st.open;
    time += st.service;
    cur = j;
  }
  time += d[cur]![instance.depot]!;
  return time;
}
