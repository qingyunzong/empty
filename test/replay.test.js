import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { replay } from "../src/replay.js";

const BIN = fileURLToPath(new URL("../bin/interlock.js", import.meta.url));

const CFG = {
  pressureLimit: 1000,
  tempLimit: 180,
  windowMs: 10000,
  holdMs: 3000,
  watermarkLagMs: 1000,
};

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "interlock-"));
}

function writeInput(dir, name, events) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir.endsWith(".jsonl") ? dir : path.join(dir, name), events.join("\n") + "\n");
}

function readJsonl(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

function runCli(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (opts.killWhen) opts.killWhen(child);
  });
}

// ---------- acceptance 1: out-of-order data revokes a false TRIP ----------

test("out-of-order late sample revokes false ARM/TRIP with compensation", async () => {
  const inDir = tmpdir();
  const outDir = tmpdir();
  const s = (id, eventTs, tag, value) =>
    JSON.stringify({ type: "sensor", id, eventTs, tag, value, unit: tag === "PT-101" ? "kPa" : "C", seq: 1 });
  const events = [
    s("p0", 0, "PT-101", 1100),
    s("m0", 0, "TT-201", 190),
    s("p1", 1000, "PT-101", 1100),
    s("m1", 1000, "TT-201", 190),
    s("p2", 2000, "PT-101", 1100),
    s("m2", 2000, "TT-201", 190),
    s("p3", 3000, "PT-101", 1100),
    s("m3", 3000, "TT-201", 190),
    JSON.stringify({ type: "trip", id: "tr1", eventTs: 3500, channel: "CH1", state: "ON" }),
    s("p4", 4000, "PT-101", 1100),
    s("m4", 4000, "TT-201", 190),
    // Late out-of-order sample: normal temperature at t=1500 breaks the
    // sustained condition, so the earlier ARM@3000 / TRIP@3500 were false.
    s("m-late", 1500, "TT-201", 150),
  ];
  writeInput(inDir, "events.jsonl", events);
  await replay({ inDir, outDir, config: CFG });

  const states = readJsonl(path.join(outDir, "states.jsonl"));
  // The false ARM/TRIP were emitted before the late sample arrived.
  assert.ok(states.some((r) => r.kind === "ARM" && r.ts === 3000), "false ARM was emitted");
  assert.ok(
    states.some((r) => r.kind === "TRIP" && r.channel === "CH1" && r.ts === 3500),
    "false TRIP was emitted",
  );
  // Reverse compensation for the false TRIP (and the rest of the tail):
  const compensations = states.filter((r) => r.kind === "COMPENSATE");
  const revokedKeys = compensations.map((r) => r.revokes);
  assert.ok(revokedKeys.includes("TRIP:CH1@3500"), "false TRIP must be revoked");
  assert.ok(revokedKeys.includes("ARM@3000"), "false ARM must be revoked");
  // Corrected final state appended after compensation: ARM at 5000, TRIP at 5000.
  assert.deepEqual(
    states.slice(-4).map((r) => `${r.kind}@${r.ts}`),
    ["ARM@5000", "TRIP@5000", "TRIP_CLEAR@14000", "DISARM@14000"],
  );

  // late.log records the late sample with the watermark at arrival.
  const late = readJsonl(path.join(outDir, "late.log"));
  const lateEntry = late.find((l) => l.id === "m-late");
  assert.ok(lateEntry, "late sample must be logged");
  assert.equal(lateEntry.reason, "late-sample");
  assert.equal(lateEntry.watermark, 3000);

  // proof.json confirms the trip with evidence.
  const proof = JSON.parse(fs.readFileSync(path.join(outDir, "proof.json"), "utf8"));
  assert.deepEqual(
    proof.transitions.map((t) => `${t.kind}@${t.ts}`),
    ["ARM@5000", "TRIP@5000", "TRIP_CLEAR@14000", "DISARM@14000"],
  );
  assert.equal(proof.trips.length, 1);
  assert.equal(proof.trips[0].ts, 5000);
  assert.equal(proof.trips[0].verdict, "COMBINATION_CONFIRMED");
  assert.equal(proof.arms.length, 1);
  assert.equal(proof.arms[0].startTs, 5000);
  assert.ok(proof.arms[0].sustainedMs >= 3000);
  assert.ok(proof.arms[0].evidence.samples.length > 0);
});

// ---------- UNIT_MISSING via CLI ----------

test("CLI exits 2 with UNIT_MISSING when a sensor lacks unit", async () => {
  const inDir = tmpdir();
  const outDir = tmpdir();
  writeInput(inDir, "bad.jsonl", [
    JSON.stringify({ type: "sensor", id: "x1", eventTs: 0, tag: "PT-101", value: 1100, seq: 1 }),
  ]);
  const res = await runCli(["replay", "--in", inDir, "--out", outDir]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /UNIT_MISSING/);
});

// ---------- duplicate events are idempotent ----------

test("duplicate event ids are applied exactly once", async () => {
  const inDir = tmpdir();
  const outA = tmpdir();
  const outB = tmpdir();
  const s = (id, eventTs, tag, value) =>
    JSON.stringify({ type: "sensor", id, eventTs, tag, value, unit: "u", seq: 1 });
  const base = [];
  for (const t of [0, 1000, 2000, 3000, 4000]) {
    base.push(s(`p${t}`, t, "PT-101", 1100), s(`m${t}`, t, "TT-201", 190));
  }
  writeInput(inDir, "clean.jsonl", base);
  await replay({ inDir, outDir: outA, config: CFG });
  // Same input plus exact duplicates of every line.
  const inDir2 = tmpdir();
  writeInput(inDir2, "dup.jsonl", [...base, ...base]);
  await replay({ inDir: inDir2, outDir: outB, config: CFG });
  assert.equal(
    fs.readFileSync(path.join(outB, "states.jsonl"), "utf8"),
    fs.readFileSync(path.join(outA, "states.jsonl"), "utf8"),
  );
  const lateB = readJsonl(path.join(outB, "late.log"));
  assert.ok(lateB.every((l) => l.reason === "duplicate-id"));
  assert.equal(lateB.length, base.length);
});

// ---------- acceptance 4: kill mid-run, recovery matches clean run ----------

function buildKillTestEvents() {
  const events = [];
  for (let k = 0; k < 30; k++) {
    const t = k * 200;
    const high = k % 8 < 5; // alternating pressure/temperature phases
    events.push(
      JSON.stringify({ type: "sensor", id: `p${k}`, eventTs: t, tag: "PT-101", value: high ? 1200 : 800, unit: "kPa", seq: 1 }),
      JSON.stringify({ type: "sensor", id: `m${k}`, eventTs: t, tag: "TT-201", value: high ? 200 : 150, unit: "C", seq: 1 }),
    );
    if (k === 10) events.push(JSON.stringify({ type: "trip", id: "tr1", eventTs: t + 50, channel: "CH1", state: "ON" }));
    if (k === 20) events.push(JSON.stringify({ type: "trip", id: "tr2", eventTs: t + 50, channel: "CH1", state: "OFF" }));
  }
  // duplicate lines to exercise idempotent dedup across recovery
  events.push(events[0], events[1]);
  return events;
}

test("kill -9 mid-run then restart converges to the clean-run result", async () => {
  const events = buildKillTestEvents();

  // Clean reference run.
  const inClean = tmpdir();
  const outClean = tmpdir();
  writeInput(inClean, "events.jsonl", events);
  await replay({ inDir: inClean, outDir: outClean, config: CFG });

  // Killed run: same input, delayed batches, SIGKILL after some snapshots.
  const inKill = tmpdir();
  const outKill = tmpdir();
  writeInput(inKill, "events.jsonl", events);
  const args = [
    "replay",
    "--in", inKill,
    "--out", outKill,
    "--pressure-limit", "1000",
    "--temp-limit", "180",
    "--window-ms", "10000",
    "--hold-ms", "3000",
    "--batch-delay-ms", "60",
  ];
  const first = await runCli(args, {
    killWhen(child) {
      const snapPath = path.join(outKill, "snapshot.json");
      const timer = setInterval(() => {
        try {
          const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
          if (snap.linesCommitted >= 12) {
            clearInterval(timer);
            child.kill("SIGKILL");
          }
        } catch {
          // snapshot not written yet
        }
      }, 15);
      child.on("close", () => clearInterval(timer));
    },
  });
  assert.equal(first.signal, "SIGKILL");
  const snapAfterKill = JSON.parse(fs.readFileSync(path.join(outKill, "snapshot.json"), "utf8"));
  assert.ok(snapAfterKill.linesCommitted >= 12, "must have committed batches before kill");
  assert.ok(snapAfterKill.linesCommitted < events.length, "must not have finished before kill");

  // Restart: resumes from the last committed batch.
  const second = await runCli(args.filter((a) => a !== "60" && a !== "--batch-delay-ms"));
  assert.equal(second.code, 0, second.stderr);

  for (const name of ["states.jsonl", "proof.json", "late.log"]) {
    assert.equal(
      fs.readFileSync(path.join(outKill, name), "utf8"),
      fs.readFileSync(path.join(outClean, name), "utf8"),
      `${name} must be identical between killed+recovered run and clean run`,
    );
  }
});

test("recovery is idempotent when the last batch is replayed after a kill", async () => {
  // Kill can land after effects were computed in memory but before the
  // snapshot was written; the uncommitted batch is re-applied on restart and
  // dedup by id must keep results consistent.
  const events = buildKillTestEvents();
  const inDir = tmpdir();
  const outDir = tmpdir();
  writeInput(inDir, "events.jsonl", events);
  await replay({ inDir, outDir, config: CFG });
  const statesOnce = fs.readFileSync(path.join(outDir, "states.jsonl"), "utf8");
  // Re-run against the same out dir: nothing new to commit, outputs unchanged.
  await replay({ inDir, outDir, config: CFG });
  assert.equal(fs.readFileSync(path.join(outDir, "states.jsonl"), "utf8"), statesOnce);
});
