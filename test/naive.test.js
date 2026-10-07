import { test } from "node:test";
import assert from "node:assert/strict";
import { settle } from "../lib/engine.js";
import { naiveSettle, recordsEqual } from "../lib/naive.js";

// Deterministic PRNG (mulberry32) so failures are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEvents(rand, n) {
  const events = [];
  const ids = [];
  for (let i = 0; i < n; i++) {
    const roll = rand();
    const ts = Math.floor(rand() * 1_000_000);
    const mch = `m${Math.floor(rand() * 4)}`;
    if (roll < 0.2 && ids.length > 0) {
      // void an existing id (sometimes already voided / unknown is fine too)
      const id = rand() < 0.9 ? ids[Math.floor(rand() * ids.length)] : `ghost${i}`;
      events.push({ type: "void", id, mch, ts });
    } else {
      // mostly fresh ids, sometimes a deliberate duplicate
      const id = rand() < 0.15 && ids.length > 0 ? ids[Math.floor(rand() * ids.length)] : `t${i}`;
      ids.push(id);
      events.push({ type: rand() < 0.5 ? "auth" : "capture", id, mch, amt: Math.floor(rand() * 10_000), ts });
    }
  }
  return events;
}

test("D: streaming engine matches naive full replay on randomized inputs (<=200 events)", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const rand = mulberry32(seed);
    const events = randomEvents(rand, 200);
    const wmLag = Math.floor(rand() * 50_000);
    const streaming = settle(events, wmLag);
    const naive = naiveSettle(events, wmLag);
    assert.ok(
      recordsEqual(streaming, naive),
      `seed ${seed} diverged\nstreaming: ${JSON.stringify(streaming)}\nnaive: ${JSON.stringify(naive)}`,
    );
  }
});

test("D: fixed edge-case replays match naive", () => {
  const cases = [
    [],
    [{ type: "capture", id: "a", mch: "m", amt: 1, ts: 0 }],
    [
      { type: "capture", id: "a", mch: "m", amt: 5, ts: 0 },
      { type: "void", id: "a", mch: "m", ts: 1 },
      { type: "capture", id: "a", mch: "m", amt: 7, ts: 2 }, // re-use after void
    ],
    [
      { type: "capture", id: "a", mch: "m", amt: 5, ts: 900_000 },
      { type: "capture", id: "b", mch: "m", amt: 6, ts: 0 }, // late
      { type: "void", id: "b", mch: "m", ts: 901_000 }, // void of late (never posted) id
    ],
  ];
  for (const events of cases) {
    for (const wmLag of [0, 3_000, 120_000]) {
      assert.ok(recordsEqual(settle(events, wmLag), naiveSettle(events, wmLag)));
    }
  }
});
