/**
 * 全路径枚举对照器：以深度优先搜索枚举所有不超过 maxTransfers 次换乘的
 * 可行行程，再用与主算法完全相同的比较器选出最优，用于交叉验证
 * JourneyPlanner.query 的正确性（包括取消班次后的重查）。
 */
import {
  buildItinerary,
  compareRoutes,
  type Itinerary,
  type Leg,
  type PlannerOptions,
  type Trip,
} from "./planner.js";

export function enumerateBest(
  trips: Trip[],
  options: PlannerOptions,
  from: string,
  to: string,
  departAfter: number,
): Itinerary | null {
  const maxTransfers = options.maxTransfers ?? 3;
  const minTransfer = options.minTransfer ?? 0;
  const stationMinTransfer = options.stationMinTransfer ?? {};
  const minTransferAt = (station: string): number =>
    stationMinTransfer[station] ?? minTransfer;

  if (from === to) {
    return { legs: [], arrival: departAfter, transfers: 0 };
  }
  const maxBoardings = maxTransfers + 1;

  const byStation = new Map<string, Array<{ trip: Trip; stopIndex: number }>>();
  for (const trip of trips) {
    trip.stops.forEach((stop, stopIndex) => {
      let list = byStation.get(stop.station);
      if (!list) {
        list = [];
        byStation.set(stop.station, list);
      }
      list.push({ trip, stopIndex });
    });
  }

  let best: Leg[] | null = null;

  function dfs(station: string, time: number, legs: Leg[]): void {
    if (station === to && legs.length > 0) {
      // 到达即记录；继续走下去再回来只会更晚、换乘更多，不可能更优。
      if (best === null || compareRoutes(legs, best) < 0) {
        best = legs;
      }
      return;
    }
    if (legs.length >= maxBoardings) return;
    const refs = byStation.get(station);
    if (!refs) return;
    const earliestBoard =
      legs.length === 0 ? departAfter : time + minTransferAt(station);
    for (const { trip, stopIndex } of refs) {
      const lastLeg = legs[legs.length - 1];
      if (lastLeg && lastLeg.tripId === trip.id) continue;
      const stop = trip.stops[stopIndex]!;
      if (stop.departure < earliestBoard) continue;
      for (let j = stopIndex + 1; j < trip.stops.length; j++) {
        const down = trip.stops[j]!;
        dfs(down.station, down.arrival, [
          ...legs,
          {
            tripId: trip.id,
            from: station,
            to: down.station,
            depart: stop.departure,
            arrive: down.arrival,
          },
        ]);
      }
    }
  }

  dfs(from, departAfter, []);
  return best === null ? null : buildItinerary(best);
}
