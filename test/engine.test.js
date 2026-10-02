import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InterlockEngine,
  computeTransitions,
  UnitMissingError,
  DEFAULT_CONFIG,
} from "../src/engine.js";

const CFG = {
  ...DEFAULT_CONFIG,
  windowMs: 10000,
  holdMs: 3000,
  watermarkLagMs: 1000,
  pressureLimit: 1000,
  tempLimit: 180,
};

function sensor(id, eventTs, tag, value, seq = 1) {
  return { type: "sensor", id, eventTs, tag, value, unit: "u", seq };
}

function feed(engine, events) {
  const logs = [];
  for (const ev of events) logs.push(...engine.applyEvent(ev).logs);
  return logs;
}

// ---------- acceptance 2: watermark boundary & threshold equality ----------

test("watermark boundary: sample exactly at watermark is on-time, below is late", () => {
  const e = new InterlockEngine(CFG);
  let logs = feed(e, [sensor("a", 5000, "PT-101", 1100)]);
  assert.equal(logs.length, 0);
  assert.equal(e.watermark(), 4000);
  // exactly at the watermark boundary -> NOT late
  logs = feed(e, [sensor("b", 4000, "TT-201", 190)]);
  assert.equal(logs.length, 0);
  // one ms below the watermark -> late
  logs = feed(e, [sensor("c", 3999, "PT-101", 1100)]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].reason, "late-sample");
  assert.equal(logs[0].watermark, 4000);
});

test("threshold equality: value exactly == limit does not ARM, limit+1 does", () => {
  const e = new InterlockEngine(CFG);
  const events = [];
  for (const t of [0, 1000, 2000, 3000, 4000]) {
    events.push(sensor(`p${t}`, t, "PT-101", 1000)); // exactly at limit
    events.push(sensor(`m${t}`, t, "TT-201", 180)); // exactly at limit
  }
  feed(e, events);
  let { added } = e.diff();
  assert.deepEqual(added, []);

  const e2 = new InterlockEngine(CFG);
  const events2 = [];
  for (const t of [0, 1000, 2000, 3000, 4000]) {
    events2.push(sensor(`p${t}`, t, "PT-101", 1001));
    events2.push(sensor(`m${t}`, t, "TT-201", 181));
  }
  feed(e2, events2);
  ({ added } = e2.diff());
  assert.deepEqual(
    added.map((t) => `${t.kind}@${t.ts}`),
    ["ARM@3000", "DISARM@14000"],
  );
});

// ---------- hand-computed cases ----------

test("sustained combination ARMs after holdMs; jitter does not", () => {
  const e = new InterlockEngine(CFG);
  // temperature jitters: high only from 0..2000 (below 3000ms hold)
  feed(e, [
    sensor("p0", 0, "PT-101", 1100),
    sensor("m0", 0, "TT-201", 190),
    sensor("p1", 2000, "PT-101", 1100),
    sensor("m1", 2000, "TT-201", 100), // drops below limit
    sensor("p2", 5000, "PT-101", 1100),
    sensor("m2", 5000, "TT-201", 100),
  ]);
  const { added } = e.diff();
  assert.deepEqual(added, []);
});

test("retract restores an alarm that was suppressed by a normal sample", () => {
  const e = new InterlockEngine(CFG);
  // High P/T sustained, but a normal temp sample at 1500 breaks the run.
  feed(e, [
    sensor("p0", 0, "PT-101", 1100),
    sensor("m0", 0, "TT-201", 190),
    sensor("p1", 1000, "PT-101", 1100),
    sensor("m1", 1000, "TT-201", 190),
    sensor("bad", 1500, "TT-201", 100), // suppresses ARM
    sensor("p2", 2000, "PT-101", 1100),
    sensor("m2", 2000, "TT-201", 190),
    sensor("p3", 3000, "PT-101", 1100),
    sensor("m3", 3000, "TT-201", 190),
  ]);
  let r = e.diff();
  // run [2000, 13000) -> ARM@5000
  assert.deepEqual(
    r.added.map((t) => t.key),
    ["ARM@5000", "DISARM@13000"],
  );
  // Retract the suppressing sample: run becomes [0, 13000) -> ARM@3000.
  feed(e, [{ type: "retract", eventTs: 4000, kind: "sensor", id: "bad" }]);
  r = e.diff();
  assert.deepEqual(
    r.revoked.map((t) => t.key),
    ["DISARM@13000", "ARM@5000"],
  );
  assert.deepEqual(
    r.added.map((t) => t.key),
    ["ARM@3000", "DISARM@13000"],
  );
});

test("sensor without unit throws UNIT_MISSING", () => {
  const e = new InterlockEngine(CFG);
  assert.throws(
    () => e.applyEvent({ type: "sensor", id: "x", eventTs: 0, tag: "PT-101", value: 1 }),
    (err) => err instanceof UnitMissingError && err.code === "UNIT_MISSING",
  );
});

// ---------- acceptance 3: enumeration vs independent reference ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent reference implementation: midpoint sampling of segments,
// separate interval assembly. Shares no code with the engine.
function referenceTransitions(samples, tripEvents, cfg) {
  const crit = new Set();
  for (const s of samples) {
    if (s.tag === cfg.pressureTag || s.tag === cfg.tempTag) {
      crit.add(s.eventTs);
      crit.add(s.eventTs + cfg.windowMs);
    }
  }
  const pts = [...crit].sort((a, b) => a - b);
  const valueOf = (tag, t) => {
    let chosen = null;
    for (const s of samples) {
      if (s.tag !== tag) continue;
      if (s.eventTs > t || s.eventTs <= t - cfg.windowMs) continue;
      if (
        !chosen ||
        s.eventTs > chosen.eventTs ||
        (s.eventTs === chosen.eventTs &&
          (s.seq > chosen.seq || (s.seq === chosen.seq && s.arrivalIdx > chosen.arrivalIdx)))
      ) {
        chosen = s;
      }
    }
    return chosen ? chosen.value : null;
  };
  const cond = (t) => {
    const p = valueOf(cfg.pressureTag, t);
    const m = valueOf(cfg.tempTag, t);
    return p !== null && m !== null && p > cfg.pressureLimit && m > cfg.tempLimit;
  };
  const runs = [];
  let start = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const mid = (pts[i] + pts[i + 1]) / 2;
    const c = cond(mid);
    if (c && start === null) start = pts[i];
    if (!c && start !== null) {
      runs.push([start, pts[i]]);
      start = null;
    }
  }
  if (start !== null) runs.push([start, pts[pts.length - 1]]);
  const arms = runs
    .filter(([a, b]) => b - a >= cfg.holdMs)
    .map(([a, b]) => ({ start: a + cfg.holdMs, end: b }));

  const sorted = [...tripEvents].sort(
    (a, b) => a.eventTs - b.eventTs || a.arrivalIdx - b.arrivalIdx,
  );
  const intervalsByChannel = new Map();
  const onSince = new Map();
  for (const e of sorted) {
    const cur = onSince.get(e.channel);
    if (e.state && cur === undefined) onSince.set(e.channel, e.eventTs);
    if (!e.state && cur !== undefined) {
      if (!intervalsByChannel.has(e.channel)) intervalsByChannel.set(e.channel, []);
      intervalsByChannel.get(e.channel).push([cur, e.eventTs]);
      onSince.delete(e.channel);
    }
  }
  for (const [ch, s] of onSince) {
    if (!intervalsByChannel.has(ch)) intervalsByChannel.set(ch, []);
    intervalsByChannel.get(ch).push([s, Infinity]);
  }

  const out = [];
  for (const arm of arms) {
    out.push({ kind: "ARM", ts: arm.start });
    out.push({ kind: "DISARM", ts: arm.end });
    for (const [channel, ivs] of intervalsByChannel) {
      for (const [s0, e0] of ivs) {
        const s = Math.max(s0, arm.start);
        const e = Math.min(e0, arm.end);
        if (s < e) {
          out.push({ kind: "TRIP", channel, ts: s });
          out.push({ kind: "TRIP_CLEAR", channel, ts: e });
        }
      }
    }
  }
  const prio = { TRIP_CLEAR: 0, DISARM: 1, ARM: 2, TRIP: 3 };
  out.sort(
    (a, b) =>
      a.ts - b.ts ||
      prio[a.kind] - prio[b.kind] ||
      String(a.channel ?? "").localeCompare(String(b.channel ?? "")),
  );
  for (const t of out) t.key = t.channel ? `${t.kind}:${t.channel}@${t.ts}` : `${t.kind}@${t.ts}`;
  return out;
}

test("enumeration: random pressure/temperature/trip sequences match reference", () => {
  const rand = mulberry32(20261003);
  const cfg = { ...CFG };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  for (let iter = 0; iter < 300; iter++) {
    const samples = [];
    let idx = 0;
    for (const tag of ["PT-101", "TT-201"]) {
      const limit = tag === "PT-101" ? cfg.pressureLimit : cfg.tempLimit;
      const n = 1 + Math.floor(rand() * 6);
      const used = new Set();
      for (let k = 0; k < n; k++) {
        let ts = Math.floor(rand() * 120) * 100;
        while (used.has(ts)) ts = Math.floor(rand() * 120) * 100;
        used.add(ts);
        const value = pick([limit - 100, limit - 1, limit, limit + 1, limit + 100]);
        samples.push({ id: `s${idx}`, eventTs: ts, tag, value, seq: 1, arrivalIdx: idx });
        idx++;
      }
    }
    const tripEvents = [];
    const nTr = Math.floor(rand() * 4);
    for (let k = 0; k < nTr; k++) {
      tripEvents.push({
        id: `tr${k}`,
        eventTs: Math.floor(rand() * 120) * 100,
        channel: pick(["CH1", "CH2"]),
        state: rand() < 0.5,
        arrivalIdx: idx++,
      });
    }
    const expected = referenceTransitions(samples, tripEvents, cfg);
    const actual = computeTransitions(samples, tripEvents, cfg);
    assert.deepEqual(
      actual,
      expected,
      `mismatch at iter ${iter}: ${JSON.stringify({ samples, tripEvents })}`,
    );
  }
});

test("enumeration: arrival order does not change derived transitions", () => {
  const rand = mulberry32(777);
  const cfg = { ...CFG };
  const samples = [];
  for (let k = 0; k < 12; k++) {
    const tag = k % 2 === 0 ? "PT-101" : "TT-201";
    samples.push({
      id: `s${k}`,
      eventTs: k * 700,
      tag,
      value: 900 + Math.floor(rand() * 300),
      seq: 1,
      arrivalIdx: k,
    });
  }
  const base = computeTransitions(samples, [], cfg);
  const shuffled = [...samples].sort(() => rand() - 0.5);
  // arrivalIdx follows the sample object; recompute with shuffled array order.
  const again = computeTransitions(shuffled, [], cfg);
  assert.deepEqual(again, base);
});
