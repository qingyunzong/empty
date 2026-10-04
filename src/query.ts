import { compareCost, compareTripSeq, type Costed } from "./cost.js";
import {
  activeTrips,
  minTransferAt,
  type Itinerary,
  type Leg,
  type Network,
  type Trip,
} from "./network.js";

/** Maximum number of transfers allowed in a journey. */
export const MAX_TRANSFERS = 3;

interface State extends Costed {
  station: string;
  /** Trip that brought us to `station` (null at the origin). */
  lastTrip: string | null;
  legs: Leg[];
}

/** Binary min-heap ordered by route preference. */
class StateHeap {
  private items: State[] = [];

  get size(): number {
    return this.items.length;
  }

  push(state: State): void {
    const items = this.items;
    items.push(state);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compareCost(items[parent]!, items[i]!) <= 0) break;
      const tmp = items[parent]!;
      items[parent] = items[i]!;
      items[i] = tmp;
      i = parent;
    }
  }

  pop(): State | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && compareCost(items[left]!, items[smallest]!) < 0) smallest = left;
        if (right < items.length && compareCost(items[right]!, items[smallest]!) < 0) smallest = right;
        if (smallest === i) break;
        const tmp = items[smallest]!;
        items[smallest] = items[i]!;
        items[i] = tmp;
        i = smallest;
      }
    }
    return top;
  }
}

function toItinerary(state: State): Itinerary {
  return { legs: state.legs, arrival: state.arrival, transfers: state.transfers };
}

/**
 * Finds the best journey from `from` to `to`, leaving no earlier than
 * `start` (absolute minutes). "Best" means: earliest arrival, then fewest
 * transfers, then smallest trip-id sequence. Changing trips at a station
 * requires that station's minimum transfer time. Returns null when no
 * journey with at most MAX_TRANSFERS transfers exists.
 *
 * The search is a uniform-cost (best-first) search over journey prefixes.
 * Every expansion strictly increases the preference cost, so the first
 * time a state at `to` is popped it is optimal. Dominance pruning is only
 * applied between states with the same station, same last trip and the
 * same set of already-used trips, where an earlier arrival and a
 * lexicographically smaller trip sequence provably dominate.
 */
export function query(network: Network, from: string, to: string, start: number): Itinerary | null {
  if (!Number.isInteger(start) || start < 0) {
    throw new Error(`start must be a non-negative integer number of minutes, got ${start}`);
  }
  if (from === to) return { legs: [], arrival: start, transfers: 0 };

  const trips = activeTrips(network);
  const boarding = new Map<string, { trip: Trip; index: number }[]>();
  for (const trip of trips) {
    for (let index = 0; index < trip.stops.length - 1; index++) {
      const station = trip.stops[index]!.station;
      let list = boarding.get(station);
      if (list === undefined) {
        list = [];
        boarding.set(station, list);
      }
      list.push({ trip, index });
    }
  }

  const heap = new StateHeap();
  heap.push({
    station: from,
    lastTrip: null,
    arrival: start,
    transfers: 0,
    seq: [],
    legs: [],
  });

  // Best known cost per (station, last trip, used trip set, transfer count).
  const best = new Map<string, { arrival: number; seq: readonly string[] }>();

  while (heap.size > 0) {
    const state = heap.pop()!;
    if (state.station === to) return toItinerary(state);

    const usedKey = [...state.seq].sort().join("");
    const key = `${state.station}${state.lastTrip ?? ""}${state.transfers}${usedKey}`;
    const known = best.get(key);
    if (
      known !== undefined &&
      (known.arrival < state.arrival ||
        (known.arrival === state.arrival && compareTripSeq(known.seq, state.seq) <= 0))
    ) {
      continue;
    }
    best.set(key, { arrival: state.arrival, seq: state.seq });

    const isOrigin = state.lastTrip === null;
    const readyAt = isOrigin
      ? state.arrival
      : state.arrival + minTransferAt(network, state.station);
    const transfers = isOrigin ? 0 : state.transfers + 1;
    if (transfers > MAX_TRANSFERS) continue;

    for (const { trip, index } of boarding.get(state.station) ?? []) {
      if (state.seq.includes(trip.id)) continue;
      const board = trip.stops[index]!;
      if (board.departure < readyAt) continue;
      const seq = [...state.seq, trip.id];
      for (let j = index + 1; j < trip.stops.length; j++) {
        const alight = trip.stops[j]!;
        heap.push({
          station: alight.station,
          lastTrip: trip.id,
          arrival: alight.arrival,
          transfers,
          seq,
          legs: [
            ...state.legs,
            {
              tripId: trip.id,
              from: state.station,
              to: alight.station,
              depart: board.departure,
              arrive: alight.arrival,
            },
          ],
        });
      }
    }
  }
  return null;
}
