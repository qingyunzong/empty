import { compareCost, type Costed } from "./cost.js";
import {
  activeTrips,
  minTransferAt,
  type Itinerary,
  type Leg,
  type Network,
} from "./network.js";
import { MAX_TRANSFERS } from "./query.js";

interface Candidate extends Costed {
  legs: Leg[];
}

/**
 * Reference implementation: exhaustively enumerates every feasible journey
 * (up to MAX_TRANSFERS transfers, no trip used twice) and returns the best
 * one under the shared preference order. Used to cross-check `query`.
 */
export function queryBruteForce(
  network: Network,
  from: string,
  to: string,
  start: number,
): Itinerary | null {
  if (from === to) return { legs: [], arrival: start, transfers: 0 };

  const trips = activeTrips(network);
  const legs: Leg[] = [];
  const seq: string[] = [];
  const candidates: Candidate[] = [];

  const dfs = (station: string, readyAt: number): void => {
    for (const trip of trips) {
      if (seq.includes(trip.id)) continue;
      for (let index = 0; index < trip.stops.length - 1; index++) {
        const board = trip.stops[index]!;
        if (board.station !== station || board.departure < readyAt) continue;
        for (let j = index + 1; j < trip.stops.length; j++) {
          const alight = trip.stops[j]!;
          legs.push({
            tripId: trip.id,
            from: station,
            to: alight.station,
            depart: board.departure,
            arrive: alight.arrival,
          });
          seq.push(trip.id);
          if (alight.station === to) {
            candidates.push({
              arrival: alight.arrival,
              transfers: legs.length - 1,
              seq: [...seq],
              legs: legs.map((leg) => ({ ...leg })),
            });
          } else if (legs.length <= MAX_TRANSFERS) {
            dfs(alight.station, alight.arrival + minTransferAt(network, alight.station));
          }
          seq.pop();
          legs.pop();
        }
      }
    }
  };

  dfs(from, start);

  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (best === null || compareCost(candidate, best) < 0) best = candidate;
  }
  if (best === null) return null;
  const chosen: Candidate = best;
  return { legs: chosen.legs, arrival: chosen.arrival, transfers: chosen.transfers };
}
