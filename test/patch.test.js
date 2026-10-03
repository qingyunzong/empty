"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { tmpdir, writeRun, csv, cli, readJson } = require("./helpers");

const schema = {
  tables: {
    metrics: { key: ["id"] },
    samples: { key: ["id"] },
  },
  deps: { "optimizer.lr": ["metrics"], seed: ["samples"] },
};

function makeRun(dir, lr, seed) {
  return writeRun(dir, {
    params: { optimizer: { lr }, seed },
    schema,
    data: {
      metrics: csv(["id", "loss"], [["1", "0.5"], ["2", "0.6"]]),
      samples: csv(["id", "label"], [["s1", "a"], ["s2", "b"]]),
    },
  });
}

function writeChange(dir, change) {
  const file = path.join(dir, "change.json");
  fs.writeFileSync(file, JSON.stringify(change));
  return file;
}

function journalOf(dir) {
  return fs
    .readFileSync(path.join(dir, ".snap", "journal.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
}

test("patch applies a param change and updates snapshot + index", () => {
  const dir = makeRun(tmpdir(), 0.1, 1);
  assert.equal(cli(["snap", dir]).status, 0);
  const change = writeChange(dir, { set: { "optimizer.lr": 0.9 } });
  const r = cli(["patch", dir, change]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json().touched, ["optimizer.lr"]);
  assert.deepEqual(r.json().affectedTables, ["metrics"]);
  const params = readJson(path.join(dir, "params.json"));
  assert.equal(params.optimizer.lr, 0.9);
  const snap = readJson(path.join(dir, ".snap", "snapshot.json"));
  const index = readJson(path.join(dir, ".snap", "index.json"));
  assert.equal(snap.paramsHash, index.paramsHash);
  assert.equal(index.journalSeq, 1);
  assert.deepEqual(journalOf(dir).map((e) => e.op), ["patch", "commit"]);
});

test("undo restores the previous param value from journal history", () => {
  const dir = makeRun(tmpdir(), 0.1, 1);
  cli(["snap", dir]);
  cli(["patch", dir, writeChange(dir, { set: { "optimizer.lr": 0.9 } })]);
  const r = cli(["patch", dir, writeChange(dir, { undo: ["optimizer.lr"] })]);
  assert.equal(r.status, 0);
  const params = readJson(path.join(dir, "params.json"));
  assert.equal(params.optimizer.lr, 0.1);
});

test("crash after patch before index update: recheck replays the journal", () => {
  const dir = makeRun(tmpdir(), 0.1, 1);
  cli(["snap", dir]);
  const indexBefore = readJson(path.join(dir, ".snap", "index.json"));
  const change = writeChange(dir, { set: { "optimizer.lr": 0.5 } });
  const crashed = cli(["patch", dir, change], {
    env: { ...process.env, SNAPDIFF_CRASH: "before-index" },
  });
  assert.equal(crashed.status, 3);
  // journal has a pending patch entry, index is stale, params already applied
  assert.deepEqual(journalOf(dir).map((e) => e.op), ["patch"]);
  const indexAfter = readJson(path.join(dir, ".snap", "index.json"));
  assert.equal(indexAfter.paramsHash, indexBefore.paramsHash);
  assert.equal(readJson(path.join(dir, "params.json")).optimizer.lr, 0.5);
  // diff refuses to run on inconsistent state
  const other = makeRun(tmpdir(), 0.1, 1);
  const refused = cli(["diff", dir, other]);
  assert.equal(refused.status, 13);
  assert.match(refused.stderr, /E_SNAP/);
  // recheck replays the pending entry
  const r1 = cli(["recheck", dir]);
  assert.equal(r1.status, 0);
  assert.deepEqual(r1.json().replayed, [1]);
  assert.deepEqual(journalOf(dir).map((e) => e.op), ["patch", "commit"]);
  const indexFixed = readJson(path.join(dir, ".snap", "index.json"));
  const snapFixed = readJson(path.join(dir, ".snap", "snapshot.json"));
  assert.equal(indexFixed.paramsHash, snapFixed.paramsHash);
  // replay is idempotent
  const r2 = cli(["recheck", dir]);
  assert.equal(r2.status, 0);
  assert.deepEqual(r2.json().replayed, []);
  // diff works again and reflects the patched param
  const diff = cli(["diff", dir, other]);
  assert.equal(diff.status, 1);
  const paramPaths = diff.json().params.changed.map((c) => c.path);
  assert.deepEqual(paramPaths, ["optimizer.lr"]);
});

test("patch refuses to run on top of a pending journal (E_SNAP)", () => {
  const dir = makeRun(tmpdir(), 0.1, 1);
  cli(["snap", dir]);
  const change = writeChange(dir, { set: { "optimizer.lr": 0.5 } });
  cli(["patch", dir, change], { env: { ...process.env, SNAPDIFF_CRASH: "before-index" } });
  const r = cli(["patch", dir, writeChange(dir, { set: { seed: 7 } })]);
  assert.equal(r.status, 13);
  assert.match(r.stderr, /E_SNAP/);
  assert.match(r.stderr, /recheck/);
});

test("undo of a patched param followed by recheck makes runs param-equal", () => {
  const a = makeRun(tmpdir(), 0.1, 1);
  const b = makeRun(tmpdir(), 0.1, 1);
  cli(["snap", a]);
  cli(["snap", b]);
  cli(["patch", b, writeChange(b, { set: { "optimizer.lr": 0.9 } })]);
  let diff = cli(["diff", a, b]);
  assert.deepEqual(diff.json().params.changed.map((c) => c.path), ["optimizer.lr"]);
  cli(["patch", b, writeChange(b, { undo: ["optimizer.lr"] })]);
  diff = cli(["diff", a, b]);
  assert.equal(diff.json().params.changed.length, 0);
});

test("recheck pair recomputes only tables affected by the patch (incremental)", () => {
  const a = makeRun(tmpdir(), 0.1, 1);
  const b = makeRun(tmpdir(), 0.1, 1);
  cli(["snap", a]);
  cli(["snap", b]);
  const first = cli(["recheck", a, b]);
  assert.equal(first.status, 0);
  assert.deepEqual(first.json().recomputed.sort(), ["metrics", "samples"]);
  assert.deepEqual(first.json().reused, []);
  // second run with no changes: everything reused
  const second = cli(["recheck", a, b]);
  assert.deepEqual(second.json().reused.sort(), ["metrics", "samples"]);
  assert.deepEqual(second.json().recomputed, []);
  // patch b's optimizer.lr: table data is unchanged so both tables are
  // reused, but the param diff is recomputed and reflects the change
  cli(["patch", b, writeChange(b, { set: { "optimizer.lr": 0.3 } })]);
  const third = cli(["recheck", a, b]);
  assert.equal(third.status, 0);
  assert.deepEqual(third.json().recomputed, []);
  assert.deepEqual(third.json().reused.sort(), ["metrics", "samples"]);
  assert.deepEqual(third.json().diff.params.changed.map((c) => c.path), ["optimizer.lr"]);
  // undo the param change: incremental recompute shows the runs are param-equal again
  cli(["patch", b, writeChange(b, { undo: ["optimizer.lr"] })]);
  const fourth = cli(["recheck", a, b]);
  assert.equal(fourth.json().diff.params.changed.length, 0);
  // a data change in metrics.csv invalidates only the metrics table
  fs.appendFileSync(path.join(b, "data", "metrics.csv"), "3,0.7\n");
  const fifth = cli(["recheck", a, b]);
  assert.equal(fifth.status, 0);
  assert.deepEqual(fifth.json().rebuilt.b, ["metrics"]);
  assert.deepEqual(fifth.json().recomputed, ["metrics"]);
  assert.deepEqual(fifth.json().reused, ["samples"]);
});
