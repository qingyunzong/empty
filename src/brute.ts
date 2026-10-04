import { Instance, Solution } from "./types";
import { travelMatrix } from "./instance";
import { simulateTime } from "./solver";

/**
 * Exhaustive enumeration of every feasible route (all subsets x all orders).
 * Only practical for small instances (<= 10 stations); used as the
 * ground-truth verifier for the exact solvers.
 */
export function solveBruteForce(instance: Instance): Solution {
  const { stations, depot, timeLimit } = instance;
  const n = stations.length;
  if (n - 1 > 10) throw new Error("brute force limited to <= 10 stations");
  const d = travelMatrix(instance);

  let bestProfit = 0;
  let bestDistance = 0;
  let bestRoute: number[] = [];

  const route: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  used[depot] = true;

  function evaluate(dist: number, time: number): void {
    const last = route.length > 0 ? route[route.length - 1]! : depot;
    const totalDist = dist + d[last]![depot]!;
    const totalTime = time + d[last]![depot]!;
    if (totalTime > timeLimit) return;
    let profit = 0;
    for (const i of route) profit += stations[i]!.profit;
    if (profit > bestProfit || (profit === bestProfit && totalDist < bestDistance)) {
      bestProfit = profit;
      bestDistance = totalDist;
      bestRoute = route.map((i) => stations[i]!.id);
    }
  }

  function dfs(cur: number, time: number, dist: number): void {
    evaluate(dist, time);
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      const st = stations[j]!;
      const arrival = time + d[cur]![j]!;
      const start = Math.max(arrival, st.open);
      if (start > st.close) continue;
      const departure = start + st.service;
      if (departure + d[j]![depot]! > timeLimit) continue;
      used[j] = true;
      route.push(j);
      dfs(j, departure, dist + d[cur]![j]!);
      route.pop();
      used[j] = false;
    }
  }

  dfs(depot, 0, 0);
  return {
    route: bestRoute,
    profit: bestProfit,
    distance: bestDistance,
    totalTime: simulateTime(instance, bestRoute),
  };
}
