import assert from "node:assert/strict";
import test from "node:test";
import {
  LogSearchIndex,
  MAX_REQUIREMENTS,
  findShortestSegment,
  verifyCertificate,
  type LogEvent,
  type Requirement,
} from "../src/index.js";

function ev(
  time: number,
  id: string,
  source: string,
  keywords: readonly string[],
): LogEvent {
  return { time, id, source, keywords };
}

function indexOf(events: LogEvent[]): LogSearchIndex {
  const idx = new LogSearchIndex();
  for (const e of events) idx.addEvent(e);
  return idx;
}

test("finds the shortest contiguous segment for multiple keyword requirements", () => {
  const idx = indexOf([
    ev(1, "a", "s1", ["error"]),
    ev(2, "b", "s1", ["noise"]),
    ev(3, "c", "s1", ["timeout"]),
    ev(4, "d", "s1", ["error"]),
    ev(5, "e", "s1", ["timeout"]),
  ]);
  const cert = idx.search([{ keyword: "error" }, { keyword: "timeout" }]);
  assert.ok(cert);
  assert.equal(cert.length, 2); // [c,d] and [d,e] both work; earliest start wins
  assert.deepEqual(
    cert.matching.map((m) => m.eventId).sort(),
    ["c", "d"],
  );
  assert.equal(cert.requirementCount, 2);
  const report = idx.verify([{ keyword: "error" }, { keyword: "timeout" }], cert);
  assert.ok(report.ok, report.errors.join("; "));
});

test("events are ordered by (time, id) and ties break to the earlier start", () => {
  const idx = indexOf([
    ev(1, "b", "s1", ["x"]),
    ev(1, "a", "s1", ["y"]), // same time, id orders before "b"
    ev(2, "c", "s1", ["x"]),
    ev(3, "d", "s1", ["y"]),
    ev(4, "e", "s1", ["x"]),
  ]);
  const cert = idx.search([{ keyword: "x" }, { keyword: "y" }]);
  assert.ok(cert);
  // sorted order: a(y), b(x), c(x), d(y), e(x)
  // windows of length 2 satisfying {x,y}: [a,b] and [c,d]; earliest start wins.
  assert.equal(cert.length, 2);
  assert.deepEqual(
    cert.matching.map((m) => m.eventId).sort(),
    ["a", "b"],
  );
  assert.ok(idx.verify([{ keyword: "x" }, { keyword: "y" }], cert).ok);
});

test("one event can satisfy only one requirement slot", () => {
  const idx = indexOf([
    ev(1, "a", "s1", ["error", "timeout"]), // has both keywords
    ev(2, "b", "s1", ["noise"]),
    ev(3, "c", "s1", ["error", "timeout"]),
  ]);
  const reqs = [{ keyword: "error" }, { keyword: "timeout" }];
  const cert = idx.search(reqs);
  assert.ok(cert);
  // a single event cannot fill both slots, so the segment must span a..c.
  assert.equal(cert.length, 3);
  assert.equal(new Set(cert.matching.map((m) => m.event)).size, 2);
  assert.ok(idx.verify(reqs, cert).ok);
});

test("prerequisite dependencies enforce event order", () => {
  const idx = indexOf([
    ev(1, "a", "s1", ["boot"]),
    ev(2, "b", "s1", ["login"]),
    ev(3, "c", "s1", ["boot"]),
    ev(4, "d", "s1", ["login"]),
  ]);
  // login (req 1) must be matched strictly after boot (req 0).
  const reqs: Requirement[] = [
    { keyword: "boot" },
    { keyword: "login", dependsOn: [0] },
  ];
  const cert = idx.search(reqs);
  assert.ok(cert);
  assert.equal(cert.length, 2); // a,b
  const byReq = new Map(cert.matching.map((m) => [m.requirement, m.eventId]));
  assert.equal(byReq.get(0), "a");
  assert.equal(byReq.get(1), "b");
  assert.ok(idx.verify(reqs, cert).ok);

  // Reversed dependency (boot after login) forces the c,d pair.
  const reqs2: Requirement[] = [
    { keyword: "login" },
    { keyword: "boot", dependsOn: [0] },
  ];
  const cert2 = idx.search(reqs2);
  assert.ok(cert2);
  assert.equal(cert2.length, 2);
  const byReq2 = new Map(cert2.matching.map((m) => [m.requirement, m.eventId]));
  assert.equal(byReq2.get(0), "b");
  assert.equal(byReq2.get(1), "c");
  assert.ok(idx.verify(reqs2, cert2).ok);
});

test("source mutual exclusion requires distinct sources within a group", () => {
  const idx = indexOf([
    ev(1, "a", "s1", ["error"]),
    ev(2, "b", "s1", ["timeout"]), // same source as a
    ev(3, "c", "s2", ["timeout"]),
  ]);
  const reqs: Requirement[] = [
    { keyword: "error", mutexGroup: "g" },
    { keyword: "timeout", mutexGroup: "g" },
  ];
  const cert = idx.search(reqs);
  assert.ok(cert);
  // [a,b] would reuse source s1, so the answer must be [a,c] (length 3).
  assert.equal(cert.length, 3);
  const sources = cert.matching.map((m) => m.source);
  assert.equal(new Set(sources).size, 2);
  assert.ok(idx.verify(reqs, cert).ok);
});

test("enforces the 12-requirement limit and rejects dependency cycles", () => {
  const idx = indexOf([ev(1, "a", "s1", ["x"])]);
  const tooMany = Array.from({ length: MAX_REQUIREMENTS + 1 }, () => ({
    keyword: "x",
  }));
  assert.throws(() => idx.search(tooMany), /at most 12/);
  assert.throws(
    () => idx.search([{ keyword: "x", dependsOn: [1] }, { keyword: "x", dependsOn: [0] }]),
    /cycle/,
  );
  // Exactly 12 requirements is accepted.
  const twelve = Array.from({ length: MAX_REQUIREMENTS }, () => ({ keyword: "nope" }));
  assert.equal(idx.search(twelve), null);
});

test("deletion triggers recomputation of the shortest segment", () => {
  const idx = indexOf([
    ev(1, "a", "s1", ["error"]),
    ev(2, "b", "s1", ["timeout"]),
    ev(3, "c", "s1", ["noise"]),
    ev(4, "d", "s1", ["error"]),
    ev(5, "e", "s1", ["timeout"]),
  ]);
  const reqs = [{ keyword: "error" }, { keyword: "timeout" }];
  const before = idx.search(reqs);
  assert.ok(before);
  assert.equal(before.length, 2); // a,b
  assert.equal(idx.removeEvent("b"), true);
  const after = idx.search(reqs);
  assert.ok(after);
  assert.equal(after.length, 2); // d,e now
  assert.deepEqual(
    after.matching.map((m) => m.eventId).sort(),
    ["d", "e"],
  );
  assert.ok(idx.verify(reqs, after).ok);
  assert.equal(idx.removeEvent("missing"), false);
});

test("late out-of-order corrections are integrated incrementally", () => {
  const idx = indexOf([
    ev(1, "a", "s1", ["error"]),
    ev(5, "e", "s1", ["timeout"]),
    ev(6, "f", "s1", ["error"]),
    ev(9, "i", "s1", ["timeout"]),
  ]);
  const reqs = [{ keyword: "error" }, { keyword: "timeout" }];
  const before = idx.search(reqs);
  assert.ok(before);
  assert.equal(before.length, 2); // a..e span 2 events? a,e adjacent: length 2
  // Late correction arrives with an earlier timestamp.
  idx.addEvent(ev(3, "c", "s1", ["timeout"]));
  const after = idx.search(reqs);
  assert.ok(after);
  assert.equal(after.length, 2); // a,c
  assert.deepEqual(
    after.matching.map((m) => m.eventId).sort(),
    ["a", "c"],
  );
  assert.ok(idx.verify(reqs, after).ok);
  // Duplicate ids are rejected.
  assert.throws(() => idx.addEvent(ev(4, "c", "s1", ["x"])), /duplicate/);
});

test("returns null when requirements are infeasible and verification agrees", () => {
  const idx = indexOf([ev(1, "a", "s1", ["error"])]);
  const reqs = [{ keyword: "error" }, { keyword: "missing" }];
  assert.equal(idx.search(reqs), null);
  const report = idx.verify(reqs, null);
  assert.ok(report.ok, report.errors.join("; "));
});

test("verification rejects tampered certificates", () => {
  const events = [
    ev(1, "a", "s1", ["error"]),
    ev(2, "b", "s1", ["timeout"]),
    ev(3, "c", "s1", ["error"]),
    ev(4, "d", "s1", ["timeout"]),
  ];
  const reqs = [{ keyword: "error" }, { keyword: "timeout" }];
  const cert = findShortestSegment(events, reqs);
  assert.ok(cert);

  // Same event used for both slots -> illegal one-to-one matching.
  const reused = {
    ...cert,
    matching: cert.matching.map((m) => ({ ...m, event: cert.lo })),
  };
  assert.equal(verifyCertificate(events, reqs, reused).matchingLegal, false);

  // Non-minimal window -> caught by full interval enumeration.
  const wider = { ...cert, hi: cert.hi + 1, length: cert.length + 1 };
  const widerReport = verifyCertificate(events, reqs, wider);
  assert.equal(widerReport.minimal, false);
  assert.equal(widerReport.ok, false);

  // Wrong requirement count -> count certificate check fails.
  const badCount = { ...cert, requirementCount: 1 };
  assert.equal(verifyCertificate(events, reqs, badCount).countCertificateOk, false);
});

// Seeded PRNG (mulberry32) for deterministic randomized cross-checks.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("randomized cross-check: solver vs independent interval enumeration", () => {
  const rand = rng(20261005);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const keywords = ["error", "timeout", "retry", "auth"];
  const sources = ["s1", "s2", "s3"];

  for (let round = 0; round < 300; round++) {
    const idx = new LogSearchIndex();
    const n = 1 + Math.floor(rand() * 9);
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `e${round}_${i}`;
      ids.push(id);
      // Out-of-order (late) inserts: random times, not sorted.
      const kwCount = 1 + Math.floor(rand() * 2);
      const kws = new Set<string>();
      for (let j = 0; j < kwCount; j++) kws.add(pick(keywords));
      idx.addEvent(ev(Math.floor(rand() * 20), id, pick(sources), [...kws]));
    }
    // Random deletions to exercise incremental recompute.
    for (const id of ids) {
      if (rand() < 0.25) idx.removeEvent(id);
    }

    const k = 1 + Math.floor(rand() * 4);
    const reqs: Requirement[] = [];
    for (let r = 0; r < k; r++) {
      const req: {
        keyword: string;
        dependsOn?: number[];
        mutexGroup?: string;
      } = { keyword: pick(keywords) };
      if (r > 0 && rand() < 0.4) {
        req.dependsOn = [Math.floor(rand() * r)]; // DAG: only earlier slots
      }
      if (rand() < 0.3) req.mutexGroup = "g";
      reqs.push(req);
    }

    const cert = idx.search(reqs);
    const report = idx.verify(reqs, cert);
    assert.ok(
      report.ok,
      `round ${round} failed: ${report.errors.join("; ")} ` +
        `events=${JSON.stringify(idx.getEvents())} reqs=${JSON.stringify(reqs)}`,
    );
    if (cert !== null) {
      assert.equal(cert.requirementCount, reqs.length);
      assert.equal(cert.length, cert.hi - cert.lo + 1);
    }
  }
});
