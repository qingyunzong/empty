import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../cli.js";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "recon-cli-"));
}

function runCli(args) {
  let stdout = "";
  const status = run(args, (chunk) => {
    stdout += chunk;
  });
  const trimmed = stdout.trim();
  return { status, stdout: trimmed, json: trimmed ? JSON.parse(trimmed) : null };
}

test("cli upsert/resolve/delete/snapshot happy path", () => {
  const dir = tmpdir();
  const state = path.join(dir, "a.json");

  const up = runCli(["--state", state, "--replica", "a", "upsert", '{"id":"r1","amountA":10,"amountB":10}']);
  assert.equal(up.status, 0);
  assert.equal(up.json.id, "r1");
  assert.equal(up.json.status, "open");

  const resolved = runCli(["--state", state, "resolve", "r1"]);
  assert.equal(resolved.status, 0);
  assert.equal(resolved.json.status, "resolved");

  const del = runCli(["--state", state, "delete", "r1"]);
  assert.equal(del.status, 0);
  assert.equal(del.json.id, "r1");
  assert.equal(del.json.deletedBy, "a");

  const snapFile = path.join(dir, "snap.json");
  const snap = runCli(["--state", state, "snapshot", snapFile]);
  assert.equal(snap.status, 0);
  assert.equal(snap.json.valid, true);
  const written = JSON.parse(fs.readFileSync(snapFile, "utf8"));
  assert.equal(written.certificate.valid, true);
  assert.equal(written.tombstones.length, 1);

  const verify = runCli(["--state", state, "verify", snapFile]);
  assert.deepEqual(verify.json, { authentic: true, valid: true });
});

test("cli errors are JSON with exit code 1", () => {
  const dir = tmpdir();
  const state = path.join(dir, "a.json");

  const missing = runCli(["--state", state, "resolve", "nope"]);
  assert.equal(missing.status, 1);
  assert.deepEqual(missing.json, { error: "not-found" });

  const badInput = runCli(["--state", state, "upsert", '{"id":"x"}']);
  assert.equal(badInput.status, 1);
  assert.deepEqual(badInput.json, { error: "invalid-input" });

  runCli(["--state", state, "upsert", '{"id":"r1","amountA":1,"amountB":1}']);
  runCli(["--state", state, "delete", "r1"]);
  const stale = runCli(["--state", state, "upsert", '{"id":"r1","amountA":2,"amountB":2}']);
  assert.equal(stale.status, 1);
  assert.deepEqual(stale.json, { error: "stale-resurrect" });
});

test("cli diff and merge repair two replicas to identical digests", () => {
  const dir = tmpdir();
  const stateA = path.join(dir, "a.json");
  const stateB = path.join(dir, "b.json");
  const snapA = path.join(dir, "snapA.json");
  const snapB = path.join(dir, "snapB.json");

  runCli(["--state", stateA, "--replica", "a", "upsert", '{"id":"r1","amountA":10,"amountB":10}']);
  runCli(["--state", stateA, "upsert", '{"id":"r2","amountA":20,"amountB":20}']);
  runCli(["--state", stateA, "upsert", '{"id":"r4","amountA":40,"amountB":40}']);
  runCli(["--state", stateA, "delete", "r4"]);

  runCli(["--state", stateB, "--replica", "b", "upsert", '{"id":"r2","amountA":20,"amountB":20}']);
  runCli(["--state", stateB, "upsert", '{"id":"r3","amountA":30,"amountB":30}']);

  runCli(["--state", stateA, "snapshot", snapA]);
  runCli(["--state", stateB, "snapshot", snapB]);

  const diffAtB = runCli(["--state", stateB, "diff", snapA]);
  assert.equal(diffAtB.status, 0);
  assert.deepEqual(diffAtB.json.missingRecords, ["r1"]);
  assert.deepEqual(diffAtB.json.missingTombstones, ["r4"]);

  const diffAtA = runCli(["--state", stateA, "diff", snapB]);
  assert.deepEqual(diffAtA.json.missingRecords, ["r3"]);
  assert.deepEqual(diffAtA.json.missingTombstones, []);

  const mergeA = runCli(["--state", stateA, "merge", snapB]);
  assert.equal(mergeA.status, 0);
  assert.equal(mergeA.json.merged, true);
  const mergeB = runCli(["--state", stateB, "merge", snapA]);
  assert.equal(mergeB.status, 0);

  const finalA = runCli(["--state", stateA, "snapshot"]);
  const finalB = runCli(["--state", stateB, "snapshot"]);
  assert.equal(finalA.json.digest, finalB.json.digest);
  assert.equal(finalA.json.epoch, finalB.json.epoch);
  assert.equal(finalA.json.certificate.valid, true);
  assert.equal(finalB.json.certificate.valid, true);
});

test("cli merge reports stale-resurrect and conflict end to end", () => {
  const dir = tmpdir();
  const stateA = path.join(dir, "a.json");
  const stateB = path.join(dir, "b.json");
  const snapA = path.join(dir, "snapA.json");
  const snapB = path.join(dir, "snapB.json");

  // stale-resurrect: a deletes, b replays a stale upsert, a rejects b's snapshot.
  runCli(["--state", stateA, "--replica", "a", "upsert", '{"id":"r1","amountA":10,"amountB":10}']);
  runCli(["--state", stateA, "snapshot", snapA]);
  runCli(["--state", stateB, "--replica", "b", "merge", snapA]);
  runCli(["--state", stateA, "delete", "r1"]);
  runCli(["--state", stateB, "upsert", '{"id":"r1","amountA":999,"amountB":999}']);
  runCli(["--state", stateB, "snapshot", snapB]);
  const stale = runCli(["--state", stateA, "merge", snapB]);
  assert.equal(stale.status, 1);
  assert.deepEqual(stale.json, { error: "stale-resurrect" });
  const afterStale = runCli(["--state", stateA, "snapshot"]);
  assert.equal(afterStale.json.records.length, 0);
  assert.equal(afterStale.json.tombstones.length, 1);

  // conflict: concurrent resolve (a) and delete (b).
  const dir2 = tmpdir();
  const sA = path.join(dir2, "a.json");
  const sB = path.join(dir2, "b.json");
  const snA = path.join(dir2, "snapA.json");
  const snB = path.join(dir2, "snapB.json");
  runCli(["--state", sA, "--replica", "a", "upsert", '{"id":"r1","amountA":10,"amountB":10}']);
  runCli(["--state", sA, "snapshot", snA]);
  runCli(["--state", sB, "--replica", "b", "merge", snA]);
  runCli(["--state", sA, "resolve", "r1"]);
  runCli(["--state", sB, "delete", "r1"]);
  runCli(["--state", sA, "snapshot", snA]);
  runCli(["--state", sB, "snapshot", snB]);
  const mergeA = runCli(["--state", sA, "merge", snB]);
  assert.equal(mergeA.status, 0);
  assert.equal(mergeA.json.conflicts.length, 1);
  assert.equal(mergeA.json.conflicts[0].type, "resolve-delete");
  const mergeB = runCli(["--state", sB, "merge", snA]);
  assert.equal(mergeB.status, 0);
  const certA = runCli(["--state", sA, "snapshot"]);
  const certB = runCli(["--state", sB, "snapshot"]);
  assert.equal(certA.json.certificate.valid, false);
  assert.equal(certB.json.certificate.valid, false);
  assert.equal(certA.json.digest, certB.json.digest);
});
