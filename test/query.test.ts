import { describe, test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import {
  cancelTrip,
  createNetwork,
  query,
  restoreTrip,
  type Itinerary,
  type Network,
} from "../src/index.js";

function tripIds(it: Itinerary | null): string[] {
  return it === null ? [] : it.legs.map((l) => l.tripId);
}

describe("direct trips", () => {
  const net = createNetwork({
    trips: [
      { id: "T1", stops: [
        { station: "A", arrival: 600, departure: 600 },
        { station: "B", arrival: 700, departure: 700 },
      ] },
    ],
  });

  test("finds a direct trip", () => {
    const it = query(net, "A", "B", 600);
    ok(it !== null);
    equal(it.arrival, 700);
    equal(it.transfers, 0);
    deepEqual(tripIds(it), ["T1"]);
  });

  test("cannot board before start time", () => {
    equal(query(net, "A", "B", 601), null);
  });

  test("origin equals destination is a zero-leg journey", () => {
    const it = query(net, "A", "A", 1234);
    ok(it !== null);
    equal(it.arrival, 1234);
    equal(it.legs.length, 0);
  });
});

describe("minimum transfer time", () => {
  const trips = [
    { id: "T1", stops: [
      { station: "A", arrival: 600, departure: 600 },
      { station: "X", arrival: 700, departure: 700 },
    ] },
    { id: "T2", stops: [
      { station: "X", arrival: 710, departure: 710 },
      { station: "B", arrival: 800, departure: 800 },
    ] },
    { id: "T3", stops: [
      { station: "X", arrival: 720, departure: 720 },
      { station: "B", arrival: 810, departure: 810 },
    ] },
  ];

  test("connection tighter than min transfer is rejected", () => {
    const net = createNetwork({ trips, minTransfer: { X: 15 } });
    const it = query(net, "A", "B", 600);
    ok(it !== null);
    deepEqual(tripIds(it), ["T1", "T3"]); // 700 + 15 <= 720, but > 710
    equal(it.arrival, 810);
    equal(it.transfers, 1);
  });

  test("connection exactly at min transfer is allowed", () => {
    const net = createNetwork({ trips, minTransfer: { X: 10 } });
    const it = query(net, "A", "B", 600);
    ok(it !== null);
    deepEqual(tripIds(it), ["T1", "T2"]); // 700 + 10 <= 710
    equal(it.arrival, 800);
  });

  test("min transfer defaults to zero", () => {
    const net = createNetwork({ trips });
    const it = query(net, "A", "B", 600);
    ok(it !== null);
    deepEqual(tripIds(it), ["T1", "T2"]);
  });
});

describe("crossing midnight with absolute minutes", () => {
  const net = createNetwork({
    trips: [
      { id: "NIGHT", stops: [
        { station: "A", arrival: 1430, departure: 1430 }, // 23:50
        { station: "B", arrival: 1470, departure: 1470 }, // 00:30 next day
      ] },
      { id: "MORNING", stops: [
        { station: "A", arrival: 1500, departure: 1500 }, // 01:00 next day
        { station: "B", arrival: 1560, departure: 1560 },
      ] },
    ],
  });

  test("arrival past 1440 is just a larger integer", () => {
    const it = query(net, "A", "B", 1420);
    ok(it !== null);
    deepEqual(tripIds(it), ["NIGHT"]);
    equal(it.arrival, 1470);
  });

  test("querying after midnight takes the next absolute-time trip", () => {
    const it = query(net, "A", "B", 1440);
    ok(it !== null);
    deepEqual(tripIds(it), ["MORNING"]);
    equal(it.arrival, 1560);
  });

  test("overnight connection across midnight", () => {
    const net2 = createNetwork({
      trips: [
        { id: "LATE", stops: [
          { station: "A", arrival: 1400, departure: 1400 },
          { station: "H", arrival: 1435, departure: 1435 },
        ] },
        { id: "RED_EYE", stops: [
          { station: "H", arrival: 1450, departure: 1450 },
          { station: "B", arrival: 1520, departure: 1520 },
        ] },
      ],
      minTransfer: { H: 10 },
    });
    const it = query(net2, "A", "B", 1390);
    ok(it !== null);
    deepEqual(tripIds(it), ["LATE", "RED_EYE"]);
    equal(it.arrival, 1520);
  });
});

describe("transfer limit", () => {
  // Chain A -T1- B -T2- C -T3- D -T4- E -T5- F, each connection feasible.
  const trips = ["T1", "T2", "T3", "T4", "T5"].map((id, i) => ({
    id,
    stops: [
      { station: `S${i}`, arrival: 100 * (i + 1), departure: 100 * (i + 1) },
      { station: `S${i + 1}`, arrival: 100 * (i + 1) + 50, departure: 100 * (i + 1) + 50 },
    ],
  }));
  const net = createNetwork({ trips, minTransfer: { S1: 5, S2: 5, S3: 5, S4: 5 } });

  test("three transfers (four trips) are allowed", () => {
    const it = query(net, "S0", "S4", 0);
    ok(it !== null);
    equal(it.transfers, 3);
    deepEqual(tripIds(it), ["T1", "T2", "T3", "T4"]);
  });

  test("four transfers exceed the limit", () => {
    equal(query(net, "S0", "S5", 0), null);
  });
});

describe("tie-breaking", () => {
  test("fewer transfers beat equal arrival", () => {
    const net = createNetwork({
      trips: [
        { id: "DIRECT", stops: [
          { station: "A", arrival: 600, departure: 600 },
          { station: "B", arrival: 800, departure: 800 },
        ] },
        { id: "LEG1", stops: [
          { station: "A", arrival: 600, departure: 600 },
          { station: "X", arrival: 700, departure: 700 },
        ] },
        { id: "LEG2", stops: [
          { station: "X", arrival: 705, departure: 705 },
          { station: "B", arrival: 800, departure: 800 },
        ] },
      ],
    });
    const it = query(net, "A", "B", 600);
    ok(it !== null);
    deepEqual(tripIds(it), ["DIRECT"]);
    equal(it.transfers, 0);
  });

  test("trip id order breaks full ties", () => {
    const net = createNetwork({
      trips: [
        { id: "TA", stops: [
          { station: "A", arrival: 600, departure: 600 },
          { station: "X", arrival: 700, departure: 700 },
        ] },
        { id: "TX", stops: [
          { station: "X", arrival: 710, departure: 710 },
          { station: "B", arrival: 800, departure: 800 },
        ] },
        { id: "TB", stops: [
          { station: "A", arrival: 600, departure: 600 },
          { station: "Y", arrival: 700, departure: 700 },
        ] },
        { id: "TY", stops: [
          { station: "Y", arrival: 710, departure: 710 },
          { station: "B", arrival: 800, departure: 800 },
        ] },
      ],
    });
    const it = query(net, "A", "B", 600);
    ok(it !== null);
    deepEqual(tripIds(it), ["TA", "TX"]); // ["TA","TX"] < ["TB","TY"]
  });

  test("earlier arrival always wins over fewer transfers", () => {
    const net = createNetwork({
      trips: [
        { id: "SLOW_DIRECT", stops: [
          { station: "A", arrival: 600, departure: 600 },
          { station: "B", arrival: 900, departure: 900 },
        ] },
        { id: "FAST1", stops: [
          { station: "A", arrival: 600, departure: 600 },
          { station: "X", arrival: 650, departure: 650 },
        ] },
        { id: "FAST2", stops: [
          { station: "X", arrival: 660, departure: 660 },
          { station: "B", arrival: 700, departure: 700 },
        ] },
      ],
    });
    const it = query(net, "A", "B", 600);
    ok(it !== null);
    deepEqual(tripIds(it), ["FAST1", "FAST2"]);
    equal(it.arrival, 700);
  });
});

describe("cancelling trips", () => {
  const base = createNetwork({
    trips: [
      { id: "T1", stops: [
        { station: "A", arrival: 600, departure: 600 },
        { station: "B", arrival: 700, departure: 700 },
      ] },
      { id: "T2", stops: [
        { station: "A", arrival: 610, departure: 610 },
        { station: "X", arrival: 660, departure: 660 },
      ] },
      { id: "T3", stops: [
        { station: "X", arrival: 670, departure: 670 },
        { station: "B", arrival: 750, departure: 750 },
      ] },
    ],
  });

  test("re-query after cancellation falls back to the next best route", () => {
    const before = query(base, "A", "B", 600);
    ok(before !== null);
    deepEqual(tripIds(before), ["T1"]);

    const cancelled = cancelTrip(base, "T1");
    const after = query(cancelled, "A", "B", 600);
    ok(after !== null);
    deepEqual(tripIds(after), ["T2", "T3"]);
    equal(after.arrival, 750);

    // Original network is untouched (immutable update).
    deepEqual(tripIds(query(base, "A", "B", 600)), ["T1"]);
  });

  test("cancelling the last viable route yields null", () => {
    let net: Network = cancelTrip(base, "T1");
    net = cancelTrip(net, "T2");
    equal(query(net, "A", "B", 600), null);
  });

  test("restoring a trip makes it available again", () => {
    const net = restoreTrip(cancelTrip(base, "T1"), "T1");
    deepEqual(tripIds(query(net, "A", "B", 600)), ["T1"]);
  });

  test("cancelling an unknown trip throws", () => {
    let threw = false;
    try {
      cancelTrip(base, "NOPE");
    } catch {
      threw = true;
    }
    ok(threw);
  });
});
