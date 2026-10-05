import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { bruteForcePeak, dependencyClosure, planSchedule } from "../src/schedule.js";
import type { Problem } from "../src/types.js";
import { randomProblem, rng } from "./helpers.js";

function problem(partial: Partial<Problem>): Problem {
  return {
    range: { start: 0, end: 100 },
    receiver: [],
    memoryLimit: 100000,
    maxPackages: 20,
    packages: [],
    ...partial,
  };
}

test("dependency closure pulls in transitive deps and detects cycles", () => {
  const pkgs = [
    { id: "A", cover: [], bytes: 1, dictBytes: 1, needs: ["B"] },
    { id: "B", cover: [], bytes: 1, dictBytes: 1, needs: ["C"] },
    { id: "C", cover: [], bytes: 1, dictBytes: 1, needs: [] },
  ];
  const { required, extra } = dependencyClosure(["A"], pkgs);
  deepEqual([...required].sort(), ["A", "B", "C"]);
  deepEqual([...extra].sort(), ["B", "C"]);
  const cyclic = [
    { id: "A", cover: [], bytes: 1, dictBytes: 1, needs: ["B"] },
    { id: "B", cover: [], bytes: 1, dictBytes: 1, needs: ["A"] },
  ];
  let threw = false;
  try { dependencyClosure(["A"], cyclic); } catch { threw = true; }
  ok(threw, "cycle should be detected");
});

test("forced chain order produces the expected peak and releases", () => {
  const p = problem({
    packages: [
      { id: "A", cover: [{ start: 0, end: 50 }], bytes: 10, dictBytes: 5, needs: ["B"] },
      { id: "B", cover: [{ start: 50, end: 100 }], bytes: 20, dictBytes: 7, needs: ["C"] },
      { id: "C", cover: [], bytes: 4, dictBytes: 3, needs: [] },
    ],
  });
  const r = planSchedule(p, ["A", "B"]);
  ok(r.feasible);
  deepEqual(r.order, ["C", "B", "A"]);
  // decode C: 4+3=7; decode B: resident(C)=3 +20+7=30; decode A: resident(B)=7 +10+5=22
  equal(r.peak, 30);
  equal(r.lowerBound, 30); // max(4+3, 20+7+3, 10+5+7)
  equal(r.upperBound, r.peak);
  ok(r.exact);
  equal(r.totalDownloadBytes, 34);
  deepEqual(r.extraDependencies, ["C"]);
  // C's dict is released once B (its last dependent) is decoded.
  const releases = r.events.filter((e) => e.action === "release").map((e) => e.package);
  ok(releases.includes("C"), "C dict should be released after B decodes");
  // Memory never exceeds the peak at any event.
  for (const e of r.events) ok(e.memory <= r.peak, `event ${e.action} ${e.package} exceeds peak`);
});

test("scheduler picks the order that minimizes peak memory", () => {
  // A's dictionary (100) must stay resident until Z (which needs it) decodes.
  // Decoding A before B forces peak 100+10+1=111; decoding B first yields 110.
  const p = problem({
    packages: [
      { id: "A", cover: [{ start: 0, end: 40 }], bytes: 10, dictBytes: 100, needs: [] },
      { id: "B", cover: [{ start: 40, end: 80 }], bytes: 10, dictBytes: 1, needs: [] },
      { id: "Z", cover: [{ start: 80, end: 100 }], bytes: 1, dictBytes: 0, needs: ["A"] },
    ],
  });
  const r = planSchedule(p, ["A", "B", "Z"]);
  deepEqual(r.order, ["B", "A", "Z"]);
  equal(r.peak, 110); // decode A: 10+100; decode Z: resident(A)=100 + 1
});

test("infeasible when even the optimal peak exceeds the memory limit", () => {
  const p = problem({
    memoryLimit: 15,
    packages: [
      { id: "A", cover: [{ start: 0, end: 100 }], bytes: 10, dictBytes: 10, needs: [] },
    ],
  });
  const r = planSchedule(p, ["A"]);
  ok(!r.feasible);
  equal(r.peak, 20);
  ok(r.reason.includes("exceeds"), r.reason);
});

test("lower bound never exceeds the optimal peak on random instances", () => {
  const rand = rng(999);
  for (let t = 0; t < 40; t++) {
    const p = randomProblem(rand, { packages: 3 + Math.floor(rand() * 5), withDeps: true });
    const ids = p.packages.map((x) => x.id);
    const r = planSchedule(p, ids);
    ok(r.lowerBound <= r.peak, `LB ${r.lowerBound} > peak ${r.peak} on trial ${t}`);
    ok(r.peak <= r.upperBound);
  }
});

test("subset DP matches exhaustive decode-order enumeration on small state graphs", () => {
  const rand = rng(4242);
  for (let t = 0; t < 40; t++) {
    const p = randomProblem(rand, { packages: 3 + Math.floor(rand() * 5), withDeps: true });
    const ids = p.packages.map((x) => x.id);
    const r = planSchedule(p, ids);
    const bf = bruteForcePeak(p, ids);
    ok(bf !== null, "brute force should run for small graphs");
    equal(r.peak, bf, `peak mismatch on trial ${t}`);
  }
});

test("event trace memories are consistent with the resident-dict model", () => {
  const rand = rng(31337);
  for (let t = 0; t < 20; t++) {
    const p = randomProblem(rand, { packages: 5, withDeps: true });
    const ids = p.packages.map((x) => x.id);
    const r = planSchedule(p, ids);
    const byId = new Map(p.packages.map((x) => [x.id, x]));
    const decoded = new Set<string>();
    const released = new Set<string>();
    let peak = 0;
    const residentNow = (): number => {
      let mem = 0;
      for (const id of decoded) {
        if (released.has(id)) continue;
        const needed = p.packages.some(
          (q) => q.needs.includes(id) && r.required.includes(q.id) && !decoded.has(q.id),
        );
        if (needed) mem += byId.get(id)!.dictBytes;
      }
      return mem;
    };
    for (const e of r.events) {
      let mem: number;
      if (e.action === "download") {
        mem = residentNow() + byId.get(e.package)!.bytes;
      } else if (e.action === "decode") {
        mem = residentNow() + byId.get(e.package)!.bytes + byId.get(e.package)!.dictBytes;
        decoded.add(e.package);
      } else {
        released.add(e.package);
        mem = residentNow();
      }
      equal(e.memory, mem, `memory mismatch at ${e.action} ${e.package} (trial ${t})`);
      peak = Math.max(peak, mem);
    }
    equal(peak, r.peak, `trace peak mismatch on trial ${t}`);
  }
});
