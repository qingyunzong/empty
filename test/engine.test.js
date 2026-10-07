import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { settle, WINDOW_MS } from "../lib/engine.js";
import { RULE_VERSION } from "../lib/cert.js";

const W = WINDOW_MS;
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// Manual, independent certificate recomputation for one merchant window.
function manualCert(winStart, winEnd, mch, entries) {
  const canon = entries.map((e) => `${e.id}:${e.kind}:${e.amt}`).sort().join(",");
  return sha256(`${RULE_VERSION}|${winStart}|${winEnd}|${mch}|${canon}`);
}

test("A: out-of-order events plus void before close settle correctly and cert is recomputable", () => {
  // wm lag 3000ms. Events arrive out of order but all before the watermark
  // passes their window. v1 voids c1 while the window is still open.
  const events = [
    { type: "capture", id: "c2", mch: "m1", amt: 700, ts: 2_000 },
    { type: "capture", id: "c1", mch: "m1", amt: 500, ts: 1_000 },
    { type: "auth", id: "a1", mch: "m1", amt: 300, ts: 1_500 },
    { type: "void", id: "c1", mch: "m1", ts: 2_500 },
    { type: "capture", id: "c9", mch: "m2", amt: 100, ts: 2_800 },
    // advance watermark far beyond the window so everything closes
    { type: "capture", id: "z1", mch: "m9", amt: 1, ts: W + 10_000 },
  ];
  const out = settle(events, 3_000);
  const finals = out.filter((r) => r.status === "final");

  const m1 = finals.find((r) => r.mch === "m1" && r.winStart === 0);
  assert.ok(m1, "m1 window record exists");
  assert.equal(m1.winEnd, W);
  assert.equal(m1.net, 700 + 300, "voided c1 is retracted before close");

  // Certificate recomputed by hand from the effective postings must match.
  const expected = manualCert(0, W, "m1", [
    { id: "c2", kind: "capture", amt: 700 },
    { id: "a1", kind: "auth", amt: 300 },
  ]);
  assert.equal(m1.cert, expected);

  const m2 = finals.find((r) => r.mch === "m2");
  assert.equal(m2.net, 100);
  assert.ok(!out.some((r) => r.code), "no diagnostics for a clean run");
});

test("A2: arrival order does not change final records or certs", () => {
  // The first three events span less than the wm lag, so any permutation of
  // them stays ahead of the watermark; the closing event stays last.
  const head = [
    { type: "capture", id: "c1", mch: "m1", amt: 500, ts: 1_000 },
    { type: "capture", id: "c2", mch: "m1", amt: 700, ts: 2_000 },
    { type: "auth", id: "a1", mch: "m2", amt: 300, ts: 1_500 },
  ];
  const tail = { type: "capture", id: "z1", mch: "m9", amt: 1, ts: W + 10_000 };
  const base = [...head, tail];
  const reversed = [...head].reverse().concat(tail);
  const canon = (recs) => recs.map((r) => JSON.stringify(r)).sort();
  assert.deepEqual(canon(settle(base, 3_000)), canon(settle(reversed, 3_000)));
});

test("B: void after window close emits a correction and never rewrites history", () => {
  const events = [
    { type: "capture", id: "c1", mch: "m1", amt: 500, ts: 1_000 },
    // push watermark past window [0, W)
    { type: "capture", id: "c2", mch: "m1", amt: 200, ts: W + 5_000 },
    // c1's window is closed; this void must produce a correction
    { type: "void", id: "c1", mch: "m1", ts: W + 6_000 },
  ];
  const out = settle(events, 3_000);

  const final = out.find((r) => r.status === "final" && r.winStart === 0);
  assert.equal(final.net, 500, "closed window keeps its historical net");

  const corrections = out.filter((r) => r.status === "correction");
  assert.equal(corrections.length, 1);
  assert.deepEqual(
    { winStart: corrections[0].winStart, winEnd: corrections[0].winEnd, mch: corrections[0].mch, net: corrections[0].net },
    { winStart: 0, winEnd: W, mch: "m1", net: -500 },
  );
  assert.equal(
    corrections[0].cert,
    sha256(`${RULE_VERSION}|correction|0|${W}|m1|c1:500`),
    "correction cert is recomputable",
  );
});

test("C: duplicate capture id is a CONFLICT and is not double-counted", () => {
  const events = [
    { type: "capture", id: "c1", mch: "m1", amt: 500, ts: 1_000 },
    { type: "capture", id: "c1", mch: "m1", amt: 500, ts: 2_000 },
    { type: "capture", id: "z1", mch: "m9", amt: 1, ts: W + 10_000 },
  ];
  const out = settle(events, 3_000);
  const conflicts = out.filter((r) => r.code === "CONFLICT");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].line, 2);
  assert.equal(conflicts[0].reason, "duplicate-id");
  const final = out.find((r) => r.status === "final" && r.mch === "m1");
  assert.equal(final.net, 500, "first posting stands, no double count");
});

test("late events outside the watermark are recorded and not posted", () => {
  const events = [
    { type: "capture", id: "c1", mch: "m1", amt: 500, ts: 100_000 },
    { type: "capture", id: "c2", mch: "m1", amt: 700, ts: 1_000 }, // late: ts < 100_000 - 3_000
  ];
  const out = settle(events, 3_000);
  const late = out.filter((r) => r.code === "LATE");
  assert.equal(late.length, 1);
  assert.equal(late[0].id, "c2");
  assert.equal(late[0].line, 2);
  const final = out.find((r) => r.status === "final");
  assert.equal(final.net, 500);
});

test("void of unknown id and double void are CONFLICTs", () => {
  const events = [
    { type: "capture", id: "c1", mch: "m1", amt: 500, ts: 1_000 },
    { type: "void", id: "nope", mch: "m1", ts: 1_500 },
    { type: "void", id: "c1", mch: "m1", ts: 2_000 },
    { type: "void", id: "c1", mch: "m1", ts: 2_500 },
  ];
  const out = settle(events, 3_000);
  const conflicts = out.filter((r) => r.code === "CONFLICT");
  assert.equal(conflicts.length, 2);
  assert.deepEqual(conflicts.map((c) => c.line), [2, 4]);
  assert.equal(out.filter((r) => r.status === "final").length, 0, "voided posting leaves an empty window");
});

test("multiple merchants and windows aggregate independently", () => {
  const events = [
    { type: "capture", id: "c1", mch: "m1", amt: 100, ts: 1_000 },
    { type: "capture", id: "c2", mch: "m2", amt: 200, ts: 1_000 },
    { type: "capture", id: "c3", mch: "m1", amt: 300, ts: W + 1_000 },
    { type: "auth", id: "a1", mch: "m1", amt: 50, ts: W + 2_000 },
  ];
  const out = settle(events, 3_000).filter((r) => r.status === "final");
  const key = (r) => `${r.winStart}|${r.mch}`;
  const nets = Object.fromEntries(out.map((r) => [key(r), r.net]));
  assert.deepEqual(nets, { "0|m1": 100, "0|m2": 200, [`${W}|m1`]: 350 });
});
