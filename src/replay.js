// Replay runner: reads JSONL input dir, processes events in event-time batches,
// persists a crash-recovery snapshot after every committed batch, and writes
// states.jsonl (append-only effect log incl. reverse compensations),
// late.log (late/duplicate/retract audit) and proof.json (final evidence).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  InterlockEngine,
  DEFAULT_CONFIG,
  LineInvalidError,
  valueAt,
} from "./engine.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseLine(text, where) {
  let ev;
  try {
    ev = JSON.parse(text);
  } catch {
    throw new LineInvalidError(`invalid JSON at ${where}`);
  }
  if (!ev || typeof ev !== "object" || typeof ev.type !== "string") {
    throw new LineInvalidError(`missing event type at ${where}`);
  }
  if (typeof ev.eventTs !== "number" || !Number.isFinite(ev.eventTs)) {
    throw new LineInvalidError(`missing/invalid eventTs at ${where}`);
  }
  if (ev.type === "sensor") {
    if (ev.op !== "retract") {
      if (typeof ev.tag !== "string" || typeof ev.value !== "number") {
        throw new LineInvalidError(`invalid sensor event at ${where}`);
      }
    }
  } else if (ev.type === "trip") {
    if (ev.op !== "retract" && typeof ev.channel !== "string") {
      throw new LineInvalidError(`invalid trip event at ${where}`);
    }
  } else if (ev.type === "retract") {
    if (typeof ev.kind !== "string" || typeof ev.id !== "string") {
      throw new LineInvalidError(`invalid retract event at ${where}`);
    }
  } else {
    throw new LineInvalidError(`unknown event type at ${where}: ${ev.type}`);
  }
  if (ev.id === undefined && ev.type !== "retract") {
    // Deterministic id so crash-recovery re-reads stay idempotent.
    ev.id = "auto:" + crypto.createHash("sha1").update(text).digest("hex");
  }
  return ev;
}

function truncateTo(filePath, bytes) {
  if (fs.existsSync(filePath)) {
    fs.truncateSync(filePath, bytes);
  } else {
    fs.writeFileSync(filePath, "");
  }
}

function writeAtomic(filePath, content) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function stripKey(t) {
  const { key, ...rest } = t;
  return rest;
}

function buildProof(engine, cfg, inputHash) {
  const transitions = engine.emitted.map(stripKey);
  const arms = [];
  const trips = [];
  let currentArm = null;
  const openTrips = new Map();
  for (const t of engine.emitted) {
    if (t.kind === "ARM") {
      currentArm = {
        startTs: t.ts,
        endTs: null,
        sustainedMs: cfg.holdMs,
        evidence: {
          pressureValue: valueAt(engine.samples, cfg.pressureTag, t.ts, cfg.windowMs),
          tempValue: valueAt(engine.samples, cfg.tempTag, t.ts, cfg.windowMs),
          samples: engine.samples
            .filter(
              (s) =>
                (s.tag === cfg.pressureTag || s.tag === cfg.tempTag) &&
                s.eventTs > t.ts - cfg.holdMs - cfg.windowMs &&
                s.eventTs <= t.ts,
            )
            .map((s) => ({ id: s.id, eventTs: s.eventTs, tag: s.tag, value: s.value, unit: s.unit })),
        },
      };
      arms.push(currentArm);
    } else if (t.kind === "DISARM" && currentArm) {
      currentArm.endTs = t.ts;
      currentArm.sustainedMs = t.ts - currentArm.startTs + cfg.holdMs;
      currentArm = null;
    } else if (t.kind === "TRIP") {
      const trip = {
        channel: t.channel,
        ts: t.ts,
        clearedTs: null,
        armStartTs: currentArm ? currentArm.startTs : null,
        verdict: "COMBINATION_CONFIRMED",
      };
      trips.push(trip);
      openTrips.set(t.channel, trip);
    } else if (t.kind === "TRIP_CLEAR") {
      const trip = openTrips.get(t.channel);
      if (trip) {
        trip.clearedTs = t.ts;
        openTrips.delete(t.channel);
      }
    }
  }
  return {
    version: 1,
    inputHash,
    config: cfg,
    maxEventTs: engine.maxEventTs,
    watermark: engine.watermark(),
    transitions,
    arms,
    trips,
    summary: {
      armCount: arms.length,
      tripCount: trips.length,
      verdict:
        trips.length > 0
          ? "shutdown caused by sustained pressure+temperature combination"
          : "no confirmed combination trip",
    },
  };
}

export async function replay({ inDir, outDir, config = {}, batchDelayMs = 0, onBatch = null }) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  fs.mkdirSync(outDir, { recursive: true });

  const files = fs
    .readdirSync(inDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const lines = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(inDir, f), "utf8");
    text.split(/\r?\n/).forEach((l, i) => {
      if (l.trim() !== "") lines.push({ file: f, lineNo: i + 1, text: l });
    });
  }
  const inputHash = crypto
    .createHash("sha256")
    .update(lines.map((l) => l.text).join("\n"))
    .digest("hex");

  const statesPath = path.join(outDir, "states.jsonl");
  const latePath = path.join(outDir, "late.log");
  const proofPath = path.join(outDir, "proof.json");
  const snapPath = path.join(outDir, "snapshot.json");
  const snapTmp = snapPath + ".tmp";

  let engine = new InterlockEngine(cfg);
  let committed = 0;
  let statesBytes = 0;
  let lateBytes = 0;
  let recovered = false;

  if (fs.existsSync(snapTmp)) fs.rmSync(snapTmp);
  if (fs.existsSync(snapPath)) {
    try {
      const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
      if (snap.version === 1 && snap.inputHash === inputHash) {
        engine = InterlockEngine.fromJSON(snap.engine);
        committed = snap.linesCommitted;
        statesBytes = snap.statesBytes;
        lateBytes = snap.lateBytes;
        truncateTo(statesPath, statesBytes);
        truncateTo(latePath, lateBytes);
        recovered = true;
      }
    } catch {
      recovered = false;
    }
  }
  if (!recovered) {
    truncateTo(statesPath, 0);
    truncateTo(latePath, 0);
  }

  const writeProof = () =>
    writeAtomic(proofPath, JSON.stringify(buildProof(engine, cfg, inputHash), null, 2) + "\n");
  const writeSnapshot = () =>
    writeAtomic(
      snapPath,
      JSON.stringify({
        version: 1,
        inputHash,
        linesCommitted: committed,
        statesBytes,
        lateBytes,
        engine: engine.toJSON(),
      }),
    );

  // After recovery, re-align proof.json with the last committed state.
  writeProof();

  let i = committed;
  while (i < lines.length) {
    const first = parseLine(lines[i].text, `${lines[i].file}:${lines[i].lineNo}`);
    const batchTs = first.eventTs;
    const batch = [first];
    let j = i + 1;
    while (j < lines.length) {
      const ev = parseLine(lines[j].text, `${lines[j].file}:${lines[j].lineNo}`);
      if (ev.eventTs !== batchTs) break;
      batch.push(ev);
      j++;
    }

    const batchLogs = [];
    for (const ev of batch) {
      const { logs } = engine.applyEvent(ev);
      batchLogs.push(...logs);
    }
    const { revoked, added } = engine.diff();

    let statesOut = "";
    for (const r of revoked) {
      statesOut +=
        JSON.stringify({
          kind: "COMPENSATE",
          revokes: r.key,
          revoked: stripKey(r),
          ts: batchTs,
          reason: "recompute",
        }) + "\n";
    }
    for (const a of added) statesOut += JSON.stringify(stripKey(a)) + "\n";
    if (statesOut) {
      fs.appendFileSync(statesPath, statesOut);
      statesBytes += Buffer.byteLength(statesOut);
    }

    let lateOut = "";
    for (const l of batchLogs) lateOut += JSON.stringify(l) + "\n";
    if (lateOut) {
      fs.appendFileSync(latePath, lateOut);
      lateBytes += Buffer.byteLength(lateOut);
    }

    committed = j;
    i = j;
    writeProof();
    writeSnapshot();
    if (onBatch) onBatch({ batchTs, committed, total: lines.length });
    if (batchDelayMs > 0) await sleep(batchDelayMs);
  }

  return { statesPath, latePath, proofPath, snapPath, engine, linesCommitted: committed };
}
