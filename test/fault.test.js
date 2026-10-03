// Acceptance 2: fault injection at the three crash points; recover() must
// converge to a deterministic, consistent state, with half-written records
// discarded and audited.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir, cleanup, cli, cliJson } from "./helpers.js";

const EVENTS = [
  { seq: 0, ts: 1000, code: "ALARM" },
  { seq: 1, ts: 1002, code: "DEV9" },
  { seq: 2, ts: 1005, code: "TIMEOUT" },
  { seq: 3, ts: 1006, code: "DEV9" },
  { seq: 4, ts: 1009, code: "RESET" },
  { seq: 5, ts: 1011, code: "DEV9" },
  { seq: 6, ts: 1013, code: "TIMEOUT" },
  { seq: 7, ts: 1015, code: "ACK" },
  { seq: 8, ts: 1017, code: "DEV9" },
];

function ingest(dir, e, env = {}) {
  return cli(dir, ["ingest", "--seq", String(e.seq), "--ts", String(e.ts), "--code", e.code], env);
}

function queryAll(dir) {
  const r = cliJson(dir, ["query", "cooccur", "--device", "DEV9", "--timeout", "TIMEOUT", "--window", "5"]);
  assert.equal(r.code, 0, r.stderr);
  return r.json;
}

// Scenario A: crash after append, before fsync (record uncommitted).
function scenarioAfterAppend(dir) {
  for (const e of EVENTS.slice(0, 5)) assert.equal(ingest(dir, e).code, 0);
  assert.equal(cli(dir, ["freeze"]).code, 0);
  for (const e of EVENTS.slice(5, 8)) assert.equal(ingest(dir, e).code, 0);
  const crash = ingest(dir, EVENTS[8], { PLC_FAULT: "afterAppend" });
  assert.equal(crash.code, 2, "simulated crash must exit 2");
  assert.match(crash.stderr, /afterAppend/);
  const rec = cliJson(dir, ["recover"]);
  assert.equal(rec.code, 0, rec.stderr);
  return { audit: rec.json, query: queryAll(dir) };
}

// Scenario B: crash mid-manifest write (record fsynced, manifest not swapped).
function scenarioMidManifest(dir) {
  for (const e of EVENTS.slice(0, 3)) assert.equal(ingest(dir, e).code, 0);
  const crash = ingest(dir, EVENTS[3], { PLC_FAULT: "midManifest" });
  assert.equal(crash.code, 2);
  assert.match(crash.stderr, /midManifest/);
  assert.ok(existsSync(join(dir, "manifest.json.tmp")), "partial tmp manifest left behind");
  const rec = cliJson(dir, ["recover"]);
  assert.equal(rec.code, 0, rec.stderr);
  return { audit: rec.json, query: queryAll(dir) };
}

// Scenario C: crash after merged segment fsync, before manifest swap.
function scenarioBeforeMergeSwap(dir) {
  for (const e of EVENTS.slice(0, 5)) assert.equal(ingest(dir, e).code, 0);
  assert.equal(cli(dir, ["freeze"]).code, 0);
  const crash = cli(dir, ["compact"], { PLC_FAULT: "beforeMergeSwap" });
  assert.equal(crash.code, 2);
  assert.match(crash.stderr, /beforeMergeSwap/);
  const segs = readdirSync(dir).filter((f) => f.startsWith("seg-"));
  assert.equal(segs.length, 2, "orphan merged file must exist before recover");
  const rec = cliJson(dir, ["recover"]);
  assert.equal(rec.code, 0, rec.stderr);
  return { audit: rec.json, query: queryAll(dir) };
}

test("fault afterAppend: uncommitted record truncated and audited, deterministic", () => {
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const dir = tmpDir();
    try {
      runs.push(scenarioAfterAppend(dir));
    } finally {
      cleanup(dir);
    }
  }
  const [a, b] = runs;
  assert.deepEqual(a, b, "two runs must recover to identical state");
  assert.ok(a.audit.truncated && a.audit.truncated.bytes > 0, "tail must be truncated");
  assert.equal(a.audit.discardedRecords, 1, "exactly the uncommitted record is discarded");
  // only seq 0..7 committed: TIMEOUT at seq 2 and 6, DEV9 at 1,3,5 (all within +-5)
  assert.deepEqual(
    a.query.matches.map((m) => [m.timeoutSeq, m.deviceSeq]),
    [[2, 1], [2, 3], [2, 5], [6, 1], [6, 3], [6, 5]],
  );
});

test("fault midManifest: stale tmp removed, uncommitted record discarded, deterministic", () => {
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const dir = tmpDir();
    try {
      runs.push(scenarioMidManifest(dir));
    } finally {
      cleanup(dir);
    }
  }
  const [a, b] = runs;
  assert.deepEqual(a, b);
  assert.equal(a.audit.removedTmp, true);
  assert.ok(a.audit.truncated && a.audit.truncated.bytes > 0);
  assert.equal(a.audit.discardedRecords, 1);
  // only seq 0..2 committed: TIMEOUT at 2, DEV9 at 1
  assert.deepEqual(a.query.matches.map((m) => [m.timeoutSeq, m.deviceSeq]), [[2, 1]]);
});

test("fault beforeMergeSwap: orphan merged file removed, old segments intact, deterministic", () => {
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const dir = tmpDir();
    try {
      runs.push(scenarioBeforeMergeSwap(dir));
    } finally {
      cleanup(dir);
    }
  }
  const [a, b] = runs;
  assert.deepEqual(a, b);
  assert.equal(a.audit.orphans.length, 1, "merged orphan removed");
  assert.equal(a.audit.truncated, null, "no truncation needed");
  // all 5 committed events survive: TIMEOUT at 2, DEV9 at 1 and 3
  assert.deepEqual(
    a.query.matches.map((m) => [m.timeoutSeq, m.deviceSeq]),
    [[2, 1], [2, 3]],
  );
});

test("recover is idempotent and appends an audit log line", () => {
  const dir = tmpDir();
  try {
    scenarioAfterAppend(dir);
    const again = cliJson(dir, ["recover"]);
    assert.equal(again.code, 0);
    assert.deepEqual(again.json, {
      removedTmp: false, orphans: [], truncated: null, discardedRecords: 0, manifestGen: again.json.manifestGen,
    });
    const log = readFileSync(join(dir, "recover-audit.log"), "utf8").trim().split("\n");
    assert.equal(log.length, 2, "both recoveries audited");
    for (const line of log) assert.ok(JSON.parse(line).at, "audit line has timestamp");
  } finally {
    cleanup(dir);
  }
});
