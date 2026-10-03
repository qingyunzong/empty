// Acceptance 1: random events, store query vs brute-force window enumeration.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { tmpDir, cleanup, mulberry32 } from "./helpers.js";

const CODES = ["DEV1", "DEV2", "TIMEOUT", "ALARM", "ACK", "RESET", "HEARTBEAT"];

function generate(seed, n) {
  const rng = mulberry32(seed);
  const events = [];
  let ts = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    ts += 1 + Math.floor(rng() * 10);
    events.push({ seq: i, ts, code: CODES[Math.floor(rng() * CODES.length)] });
  }
  return events;
}

function bruteCooccur(events, device, timeout, window) {
  const matches = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].code !== timeout) continue;
    const lo = Math.max(0, i - window);
    const hi = Math.min(events.length - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (j !== i && events[j].code === device) {
        matches.push({
          timeoutSeq: events[i].seq, timeoutTs: events[i].ts,
          deviceSeq: events[j].seq, deviceTs: events[j].ts,
          distance: j - i,
        });
      }
    }
  }
  return matches;
}

function brutePhrase(events, phrase) {
  const hits = [];
  for (let i = 0; i + phrase.length <= events.length; i++) {
    if (phrase.every((c, k) => events[i + k].code === c)) {
      hits.push({
        startSeq: events[i].seq,
        seqs: events.slice(i, i + phrase.length).map((e) => e.seq),
        ts: events.slice(i, i + phrase.length).map((e) => e.ts),
      });
    }
  }
  return hits;
}

test("cooccur matches brute-force window enumeration across segments", () => {
  const dir = tmpDir();
  try {
    const events = generate(42, 600);
    const store = new Store(dir);
    for (const e of events) {
      store.ingest(e);
      if (e.seq === 199) store.freeze(); // split into two segments
      if (e.seq === 399) store.freeze(); // three segments
    }
    for (const [device, timeout, window] of [["DEV1", "TIMEOUT", 5], ["DEV2", "TIMEOUT", 5], ["DEV1", "ALARM", 3], ["RESET", "TIMEOUT", 0]]) {
      const got = store.queryCooccur({ device, timeout, window });
      const want = bruteCooccur(events, device, timeout, window);
      assert.deepEqual(got.matches, want, `device=${device} timeout=${timeout} window=${window}`);
      assert.equal(got.count, want.length);
    }
  } finally {
    cleanup(dir);
  }
});

test("phrase query [ALARM,ACK,RESET] matches brute force", () => {
  const dir = tmpDir();
  try {
    const events = generate(7, 400);
    // plant deterministic phrases at positions 50 and 250
    for (const start of [50, 250]) {
      events[start].code = "ALARM";
      events[start + 1].code = "ACK";
      events[start + 2].code = "RESET";
    }
    const store = new Store(dir);
    for (const e of events) {
      store.ingest(e);
      if (e.seq === 99) store.freeze();
    }
    const phrase = ["ALARM", "ACK", "RESET"];
    const got = store.queryPhrase(phrase);
    const want = brutePhrase(events, phrase);
    assert.ok(want.length >= 2, "planted phrases must exist");
    assert.deepEqual(got.hits, want);
  } finally {
    cleanup(dir);
  }
});

test("timestamps survive delta+varint round-trip through the store", () => {
  const dir = tmpDir();
  try {
    const events = generate(99, 200);
    const store = new Store(dir);
    for (const e of events) store.ingest(e);
    const got = store.queryCooccur({ device: "DEV1", timeout: "TIMEOUT", window: 5 });
    const want = bruteCooccur(events, "DEV1", "TIMEOUT", 5);
    assert.deepEqual(got.matches, want); // ts equality is checked inside matches
  } finally {
    cleanup(dir);
  }
});
