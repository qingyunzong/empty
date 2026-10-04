import { test } from "node:test";
import {
  deepEqual,
  equal,
  ok,
  throws,
} from "node:assert/strict";
import {
  LogSegmentSearcher,
  MAX_REQUIREMENTS,
  validateMatchingCertificate,
  verifyResult,
} from "../src/index.js";
import type { LogEvent, Requirement } from "../src/index.js";

function ev(
  id: string,
  time: number,
  source: string,
  keywords: string[],
): LogEvent {
  return { id, time, source, keywords };
}

function assertVerified(searcher: LogSegmentSearcher): void {
  const report = searcher.verify();
  const failures = report.checks.filter((c) => !c.ok);
  deepEqual(
    failures,
    [],
    `verification failed: ${failures.map((f) => `${f.name}: ${f.detail ?? ""}`).join("; ")}`,
  );
}

test("finds the shortest segment covering all keyword requirements", () => {
  const s = new LogSegmentSearcher([{ keyword: "error" }, { keyword: "db" }]);
  s.addEvent(ev("a", 1, "web", ["info"]));
  s.addEvent(ev("b", 2, "web", ["error"]));
  s.addEvent(ev("c", 3, "db", ["db"]));
  s.addEvent(ev("d", 4, "web", ["error", "db"]));
  const r = s.result();
  ok(r !== null);
  // Event d holds both keywords, but one event may fill only one slot,
  // so the shortest feasible segment is b..c.
  equal(r.start, 1);
  equal(r.end, 2);
  equal(r.length, 2);
  deepEqual(
    r.matching.map((m) => [m.requirement, m.eventId]),
    [
      [0, "b"],
      [1, "c"],
    ],
  );
  assertVerified(s);
});

test("events are ordered by (time, id) regardless of insertion order", () => {
  const s = new LogSegmentSearcher([{ keyword: "x" }, { keyword: "y" }]);
  s.addEvent(ev("b", 1, "s", ["y"]));
  s.addEvent(ev("a", 1, "s", ["x"]));
  const r = s.result();
  ok(r !== null);
  deepEqual(
    r.matching.map((m) => m.eventId).sort(),
    ["a", "b"],
  );
  assertVerified(s);
});

test("ties in length are broken by the earliest start", () => {
  const s = new LogSegmentSearcher([{ keyword: "x" }]);
  s.addEvent(ev("a", 1, "s", ["x"]));
  s.addEvent(ev("b", 2, "s", ["noise"]));
  s.addEvent(ev("c", 3, "s", ["x"]));
  const r = s.result();
  ok(r !== null);
  equal(r.start, 0);
  equal(r.end, 0);
  assertVerified(s);
});

test("one event cannot satisfy two requirement slots", () => {
  const s = new LogSegmentSearcher([{ keyword: "x" }, { keyword: "y" }]);
  s.addEvent(ev("a", 1, "s", ["x", "y"]));
  s.addEvent(ev("b", 2, "s", ["noise"]));
  s.addEvent(ev("c", 3, "s", ["y"]));
  const r = s.result();
  ok(r !== null);
  equal(r.length, 3, "must span a..c because event a alone cannot fill both slots");
  const ids = r.matching.map((m) => m.eventId);
  equal(new Set(ids).size, 2, "matching stays one-to-one");
  assertVerified(s);
});

test("prerequisite dependencies enforce event order", () => {
  const s = new LogSegmentSearcher([
    { keyword: "boot" },
    { keyword: "ready", prereqs: [0] },
  ]);
  s.addEvent(ev("a", 1, "s", ["ready"]));
  s.addEvent(ev("b", 2, "s", ["boot"]));
  s.addEvent(ev("c", 3, "s", ["noise"]));
  s.addEvent(ev("d", 4, "s", ["ready"]));
  const r = s.result();
  ok(r !== null);
  deepEqual(
    r.matching.map((m) => [m.requirement, m.eventId]),
    [
      [0, "b"],
      [1, "d"],
    ],
    "the 'ready' match must follow the 'boot' match",
  );
  assertVerified(s);
});

test("source mutex forces distinct sources within a group", () => {
  const s = new LogSegmentSearcher([
    { keyword: "x", mutexGroup: "g" },
    { keyword: "y", mutexGroup: "g" },
  ]);
  s.addEvent(ev("a", 1, "s1", ["x"]));
  s.addEvent(ev("b", 2, "s1", ["y"]));
  s.addEvent(ev("c", 3, "s2", ["y"]));
  const r = s.result();
  ok(r !== null);
  deepEqual(
    r.matching.map((m) => [m.requirement, m.eventId]),
    [
      [0, "a"],
      [1, "c"],
    ],
    "same-source candidate b is rejected in favour of c",
  );
  assertVerified(s);
});

test("deletion triggers recomputation", () => {
  const s = new LogSegmentSearcher([{ keyword: "x" }, { keyword: "y" }]);
  s.addEvent(ev("a", 1, "s", ["x"]));
  s.addEvent(ev("b", 2, "s", ["y"]));
  s.addEvent(ev("c", 3, "s", ["x"]));
  s.addEvent(ev("d", 4, "s", ["noise"]));
  s.addEvent(ev("e", 5, "s", ["y"]));
  const before = s.result();
  ok(before !== null);
  equal(before.length, 2);
  equal(s.deleteEvent("b"), true);
  const after = s.result();
  ok(after !== null);
  equal(after.length, 3, "window must regrow after deleting b");
  deepEqual(
    after.matching.map((m) => m.eventId).sort(),
    ["c", "e"],
  );
  assertVerified(s);
});

test("deleting every feasible event yields null and a verified infeasible certificate", () => {
  const s = new LogSegmentSearcher([{ keyword: "x" }]);
  s.addEvent(ev("a", 1, "s", ["x"]));
  s.deleteEvent("a");
  equal(s.result(), null);
  const cert = s.certificate();
  equal(cert.feasible, false);
  equal(cert.satisfiedCount, 0);
  assertVerified(s);
});

test("late corrections re-sort and recompute incrementally", () => {
  const s = new LogSegmentSearcher([{ keyword: "x" }, { keyword: "y" }]);
  s.addEvent(ev("a", 1, "s", ["x"]));
  s.addEvent(ev("b", 2, "s", ["y"]));
  const before = s.result();
  ok(before !== null);
  equal(before.length, 2);
  // Late correction: event b did not actually carry keyword y.
  s.correctEvent(ev("b", 2, "s", ["noise"]));
  equal(s.result(), null);
  assertVerified(s);
  // Another correction arrives out of order and restores feasibility.
  s.correctEvent(ev("b", 0, "s", ["y"]));
  const after = s.result();
  ok(after !== null);
  equal(after.length, 2);
  deepEqual(
    after.matching.map((m) => m.eventId).sort(),
    ["a", "b"],
  );
  assertVerified(s);
});

test("correctEvent inserts unknown ids (upsert)", () => {
  const s = new LogSegmentSearcher([{ keyword: "x" }]);
  s.correctEvent(ev("a", 1, "s", ["x"]));
  ok(s.result() !== null);
  assertVerified(s);
});

test("requirement count is capped at 12", () => {
  const reqs: Requirement[] = Array.from({ length: MAX_REQUIREMENTS + 1 }, (_, i) => ({
    keyword: `k${i}`,
  }));
  throws(() => new LogSegmentSearcher(reqs), /too many requirements/);
  const okReqs: Requirement[] = Array.from({ length: MAX_REQUIREMENTS }, (_, i) => ({
    keyword: "hit",
  }));
  const s = new LogSegmentSearcher(okReqs);
  for (let i = 0; i < MAX_REQUIREMENTS; i++) {
    s.addEvent(ev(`e${i}`, i, "s", ["hit"]));
  }
  const r = s.result();
  ok(r !== null);
  equal(r.length, MAX_REQUIREMENTS);
  assertVerified(s);
});

test("cyclic prerequisites are rejected", () => {
  throws(
    () =>
      new LogSegmentSearcher([
        { keyword: "a", prereqs: [1] },
        { keyword: "b", prereqs: [0] },
      ]),
    /cycle/,
  );
});

test("tampered matching certificates are rejected", () => {
  const events = [ev("a", 1, "s1", ["x"]), ev("b", 2, "s1", ["y"])];
  const reqs: Requirement[] = [{ keyword: "x" }, { keyword: "y" }];
  equal(
    validateMatchingCertificate(events, 0, 1, reqs, [
      { requirement: 0, eventId: "a" },
      { requirement: 1, eventId: "a" },
    ]),
    'event "a" satisfies more than one requirement',
  );
  equal(
    validateMatchingCertificate(events, 0, 1, reqs, [
      { requirement: 0, eventId: "b" },
      { requirement: 1, eventId: "b" },
    ]),
    'event "b" lacks keyword "x"',
  );
  equal(
    validateMatchingCertificate(events, 0, 1, reqs, [
      { requirement: 0, eventId: "a" },
      { requirement: 1, eventId: "b" },
    ]),
    null,
  );
});

test("randomized streams always pass independent enumeration verification", () => {
  // Deterministic LCG so failures are reproducible.
  let state = 0x2f6e2b1d;
  const rand = (n: number): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % n;
  };
  const keywords = ["alpha", "beta", "gamma", "delta"];
  const sources = ["s1", "s2", "s3"];
  const reqs: Requirement[] = [
    { keyword: "alpha" },
    { keyword: "beta", prereqs: [0] },
    { keyword: "gamma", mutexGroup: "g" },
    { keyword: "delta", mutexGroup: "g" },
  ];

  for (let trial = 0; trial < 30; trial++) {
    const s = new LogSegmentSearcher(reqs);
    let nextId = 0;
    const live: string[] = [];
    for (let step = 0; step < 40; step++) {
      const action = rand(10);
      if (action < 5 || live.length === 0) {
        const id = `e${nextId++}`;
        const kws: string[] = [];
        for (let k = 0; k < 1 + rand(2); k++) kws.push(keywords[rand(keywords.length)]!);
        s.addEvent(ev(id, rand(50), sources[rand(sources.length)]!, kws));
        live.push(id);
      } else if (action < 8) {
        const id = live[rand(live.length)]!;
        const kws: string[] = [];
        for (let k = 0; k < 1 + rand(2); k++) kws.push(keywords[rand(keywords.length)]!);
        s.correctEvent(ev(id, rand(50), sources[rand(sources.length)]!, kws));
      } else {
        const idx = rand(live.length);
        ok(s.deleteEvent(live[idx]!));
        live.splice(idx, 1);
      }
      const report = s.verify();
      ok(
        report.ok,
        `trial ${trial} step ${step}: ${report.checks
          .filter((c) => !c.ok)
          .map((c) => `${c.name}: ${c.detail ?? ""}`)
          .join("; ")}`,
      );
      const cert = s.certificate();
      const r = s.result();
      if (r === null) {
        equal(cert.feasible, false);
      } else {
        equal(cert.minLength, r.length);
        equal(cert.earliestStartAtMinLength, r.start);
        ok(cert.minLengthIntervalCount >= 1);
      }
    }
  }
});

test("verifyResult detects a forged result", () => {
  const events = [ev("a", 1, "s", ["x"]), ev("b", 2, "s", ["y"])];
  const reqs: Requirement[] = [{ keyword: "x" }, { keyword: "y" }];
  const forged = verifyResult(events, reqs, {
    start: 0,
    end: 0,
    length: 1,
    matching: [
      { requirement: 0, eventId: "a" },
      { requirement: 1, eventId: "b" },
    ],
  });
  equal(forged.ok, false);
});
