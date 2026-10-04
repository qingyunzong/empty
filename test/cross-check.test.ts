import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import {
  cancelTrip,
  createNetwork,
  minTransferAt,
  query,
  queryBruteForce,
  MAX_TRANSFERS,
  type Itinerary,
  type Network,
  type Trip,
} from "../src/index.js";

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function int(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

function randomNetwork(rand: () => number): Network {
  const stationCount = int(rand, 4, 8);
  const stations = Array.from({ length: stationCount }, (_, i) => `S${i}`);
  const tripCount = int(rand, 6, 14);
  const trips: Trip[] = [];
  for (let k = 0; k < tripCount; k++) {
    const stopCount = int(rand, 2, 5);
    const chosen = [...stations].sort(() => rand() - 0.5).slice(0, stopCount);
    let time = int(rand, 0, 1400); // may push arrivals past 1440 (cross-midnight)
    const stops = chosen.map((station) => {
      time += int(rand, 5, 60);
      const arrival = time;
      time += int(rand, 0, 10); // dwell
      return { station, arrival, departure: time };
    });
    trips.push({ id: `T${k}`, stops });
  }
  const minTransfer: Record<string, number> = {};
  for (const station of stations) {
    if (rand() < 0.7) minTransfer[station] = int(rand, 0, 15);
  }
  let net = createNetwork({ trips, minTransfer });
  for (const trip of trips) {
    if (rand() < 0.2) net = cancelTrip(net, trip.id);
  }
  return net;
}

/** Independent feasibility check for a returned itinerary. */
function assertFeasible(
  net: Network,
  it: Itinerary,
  from: string,
  to: string,
  start: number,
): void {
  ok(it.legs.length > 0, "itinerary has no legs");
  ok(it.transfers <= MAX_TRANSFERS, "too many transfers");
  equal(it.transfers, it.legs.length - 1);
  equal(it.legs[0]!.from, from);
  equal(it.legs[it.legs.length - 1]!.to, to);
  equal(it.arrival, it.legs[it.legs.length - 1]!.arrive);
  ok(it.legs[0]!.depart >= start, "leaves before start time");
  const seen = new Set<string>();
  for (let i = 0; i < it.legs.length; i++) {
    const leg = it.legs[i]!;
    ok(!net.cancelled.has(leg.tripId), "uses a cancelled trip");
    ok(!seen.has(leg.tripId), "uses a trip twice");
    seen.add(leg.tripId);
    const trip = net.trips.find((t) => t.id === leg.tripId)!;
    const bi = trip.stops.findIndex(
      (s) => s.station === leg.from && s.departure === leg.depart,
    );
    ok(bi >= 0, `leg boards ${leg.tripId} at ${leg.from}`);
    const ai = trip.stops.findIndex(
      (s, j) => j > bi && s.station === leg.to && s.arrival === leg.arrive,
    );
    ok(ai > bi, `leg alights ${leg.tripId} at ${leg.to}`);
    if (i > 0) {
      const prev = it.legs[i - 1]!;
      equal(prev.to, leg.from, "legs do not connect");
      const ready = prev.arrive + minTransferAt(net, leg.from);
      ok(leg.depart >= ready, "violates minimum transfer time");
    }
  }
}

test("query matches brute-force enumeration on random networks", () => {
  const CASES = 500;
  const rand = rng(20261005);
  let found = 0;
  for (let c = 0; c < CASES; c++) {
    const net = randomNetwork(rand);
    const stations = [...new Set(net.trips.flatMap((t) => t.stops.map((s) => s.station)))];
    const from = stations[int(rand, 0, stations.length - 1)]!;
    let to = stations[int(rand, 0, stations.length - 1)]!;
    if (to === from) to = stations[(stations.indexOf(from) + 1) % stations.length]!;
    const start = int(rand, 0, 1400);

    const fast = query(net, from, to, start);
    const brute = queryBruteForce(net, from, to, start);

    if (brute === null) {
      equal(fast, null, `case ${c}: query found a route where none exists`);
      continue;
    }
    ok(fast !== null, `case ${c}: query missed a route that exists`);
    equal(fast.arrival, brute.arrival, `case ${c}: arrival mismatch`);
    equal(fast.transfers, brute.transfers, `case ${c}: transfer count mismatch`);
    deepEqual(
      fast.legs.map((l) => l.tripId),
      brute.legs.map((l) => l.tripId),
      `case ${c}: trip sequence mismatch`,
    );
    // Same cost may still allow different transfer stops; the selection
    // rule only pins down arrival, transfers and the trip-id sequence.
    equal(fast.legs[0]!.depart, brute.legs[0]!.depart, `case ${c}: first departure mismatch`);
    assertFeasible(net, fast, from, to, start);
    found++;
  }
  ok(found > CASES / 4, `suspiciously few reachable cases: ${found}/${CASES}`);
});
