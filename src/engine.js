// Replay engine: reads JSONL events in arrival order, groups them into
// event-time batches gated by the watermark (maxEventTs - watermarkLagMs),
// emits/revokes interlock state transitions, and checkpoints a snapshot after
// every processed input line (every event-time batch boundary is covered).
//
// Recovery: on start, if snapshot.json exists, its state is restored, the
// output files are truncated to the byte offsets recorded in the snapshot
// (a crash may have happened after flushing outputs but before the snapshot
// write), and replay continues at the recorded input line. Already-seen event
// ids make re-delivery idempotent.

import fs from 'node:fs';
import path from 'node:path';
import { deriveTransitions, transitionKey } from './derive.js';
import { parseEventLine } from './events.js';

const SNAPSHOT_VERSION = 1;

function decrement(map, key) {
  map.set(key, map.get(key) - 1);
}

export class Engine {
  constructor({ inDir, outDir, config }) {
    this.inDir = inDir;
    this.outDir = outDir;
    this.config = config;

    this.samples = [];
    this.trips = [];
    this.retracted = new Set();
    this.seenIds = new Set();
    this.pending = new Map();
    this.emittedAlive = [];
    this.counts = {
      sensor: 0,
      trip: 0,
      retract: 0,
      duplicates: 0,
      late: 0,
      ignored: 0,
      bad: 0,
      unitMissing: 0,
      unitMismatch: 0,
    };
    this.diagnostics = [];
    this.maxTs = null;
    this.eof = false;
    this.linesRead = 0;
    this.commits = 0;
    this.statesBytes = 0;
    this.lateBytes = 0;
    this.restoredEof = false;

    this.statesPath = path.join(outDir, 'states.jsonl');
    this.latePath = path.join(outDir, 'late.log');
    this.snapshotPath = path.join(outDir, 'snapshot.json');
    this.proofPath = path.join(outDir, 'proof.json');
  }

  currentWatermark() {
    if (this.eof) return Infinity;
    if (this.maxTs === null) return -Infinity;
    return this.maxTs - this.config.watermarkLagMs;
  }

  readInputLines() {
    const files = fs
      .readdirSync(this.inDir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort();
    const lines = [];
    for (const name of files) {
      const content = fs.readFileSync(path.join(this.inDir, name), 'utf8');
      for (const line of content.split('\n')) lines.push(line);
    }
    return lines;
  }

  run() {
    fs.mkdirSync(this.outDir, { recursive: true });
    const snapshot = this.loadSnapshot();
    if (snapshot) {
      this.restore(snapshot);
    } else {
      fs.writeFileSync(this.statesPath, '');
      fs.writeFileSync(this.latePath, '');
    }
    this.statesFd = fs.openSync(this.statesPath, 'a');
    this.lateFd = fs.openSync(this.latePath, 'a');

    const lines = this.readInputLines();
    const startLine = this.linesRead;
    for (let index = this.linesRead; index < lines.length; index++) {
      this.linesRead = index + 1;
      this.handleLine(lines[index], index + 1);
    }

    this.eof = true;
    this.drain();
    this.recomputeAndDiff();
    if (!this.restoredEof || this.linesRead > startLine) this.commit();
    this.writeProof();

    fs.closeSync(this.statesFd);
    fs.closeSync(this.lateFd);
    return {
      commits: this.commits,
      counts: this.counts,
      trips: this.emittedAlive.filter((rec) => rec.state === 'TRIP').length,
      outDir: this.outDir,
    };
  }

  handleLine(line, lineNo) {
    const trimmed = line.trim();
    if (trimmed) {
      const result = parseEventLine(trimmed, this.config);
      if (result.diagnostic) {
        this.addDiagnostic(result.diagnostic, lineNo);
      } else if (result.ignored) {
        this.counts.ignored++;
      } else {
        this.arrive(result.event);
      }
      this.drain();
      this.recomputeAndDiff();
    }
    this.commit();
  }

  arrive(event) {
    if (this.seenIds.has(event.id)) {
      this.counts.duplicates++;
      return;
    }
    this.seenIds.add(event.id);
    const watermark = this.currentWatermark();
    if (event.ts < watermark) {
      this.counts.late++;
      this.appendLine(this.lateFd, 'late', {
        ts: event.ts,
        id: event.id,
        type: event.kind,
        reason: 'LATE_EVENT',
        watermark,
      });
      this.applyEvent(event);
      return;
    }
    if (!this.pending.has(event.ts)) this.pending.set(event.ts, []);
    this.pending.get(event.ts).push(event);
    if (this.maxTs === null || event.ts > this.maxTs) this.maxTs = event.ts;
  }

  drain() {
    const watermark = this.currentWatermark();
    const tsList = [...this.pending.keys()].sort((a, b) => a - b);
    for (const ts of tsList) {
      if (ts > watermark) break;
      const batch = this.pending.get(ts);
      this.pending.delete(ts);
      batch.sort(
        (a, b) =>
          (a.seq ?? 0) - (b.seq ?? 0) || String(a.id).localeCompare(String(b.id)),
      );
      for (const event of batch) this.applyEvent(event);
    }
  }

  applyEvent(event) {
    if (event.kind === 'sensor') {
      this.samples.push({
        id: event.id,
        ts: event.ts,
        tag: event.tag,
        value: event.value,
        seq: event.seq,
      });
      this.counts.sensor++;
    } else if (event.kind === 'trip') {
      this.trips.push({
        id: event.id,
        ts: event.ts,
        channel: event.channel,
        state: event.state,
      });
      this.counts.trip++;
    } else if (event.kind === 'retract') {
      this.retracted.add(`${event.targetKind}:${event.targetId}`);
      this.counts.retract++;
    }
  }

  activeSamples() {
    return this.samples.filter((s) => !this.retracted.has(`sensor:${s.id}`));
  }

  activeTrips() {
    return this.trips.filter((t) => !this.retracted.has(`trip:${t.id}`));
  }

  recomputeAndDiff() {
    const derived = deriveTransitions(
      this.activeSamples(),
      this.activeTrips(),
      this.config,
      this.currentWatermark(),
    );

    const remaining = new Map();
    for (const rec of derived) {
      const key = transitionKey(rec);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    const revokes = [];
    for (const rec of this.emittedAlive) {
      const key = transitionKey(rec);
      if ((remaining.get(key) ?? 0) > 0) decrement(remaining, key);
      else revokes.push(rec);
    }

    const alive = new Map();
    for (const rec of this.emittedAlive) {
      const key = transitionKey(rec);
      alive.set(key, (alive.get(key) ?? 0) + 1);
    }
    const emits = [];
    for (const rec of derived) {
      const key = transitionKey(rec);
      if ((alive.get(key) ?? 0) > 0) decrement(alive, key);
      else emits.push(rec);
    }

    for (const rec of revokes) this.appendLine(this.statesFd, 'states', { ...rec, op: 'REVOKE' });
    for (const rec of emits) this.appendLine(this.statesFd, 'states', { ...rec, op: 'EMIT' });
    this.emittedAlive = derived;
  }

  appendLine(fd, which, record) {
    const line = `${JSON.stringify(record)}\n`;
    fs.writeSync(fd, line);
    const bytes = Buffer.byteLength(line);
    if (which === 'states') this.statesBytes += bytes;
    else this.lateBytes += bytes;
  }

  addDiagnostic(diagnostic, lineNo) {
    const entry = { ...diagnostic, line: lineNo };
    this.diagnostics.push(entry);
    if (diagnostic.code === 'UNIT_MISSING') this.counts.unitMissing++;
    else if (diagnostic.code === 'UNIT_MISMATCH') this.counts.unitMismatch++;
    else this.counts.bad++;
    console.error(`${diagnostic.code} ${JSON.stringify(entry)}`);
  }

  commit() {
    fs.fsyncSync(this.statesFd);
    fs.fsyncSync(this.lateFd);
    this.commits++;
    if (this.config.crashAfterCommits === this.commits) {
      // Test hook (INTERLOCK_EXIT_AFTER_COMMITS): die after outputs are
      // durable but before the snapshot, exercising truncation on recovery.
      process.exit(42);
    }
    const tmpPath = `${this.snapshotPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.snapshotState()));
    fs.renameSync(tmpPath, this.snapshotPath);
  }

  snapshotState() {
    const pending = [];
    for (const [, batch] of this.pending) pending.push(...batch);
    return {
      version: SNAPSHOT_VERSION,
      linesRead: this.linesRead,
      commits: this.commits,
      maxTs: this.maxTs,
      eof: this.eof,
      samples: this.samples,
      trips: this.trips,
      retracted: [...this.retracted],
      seenIds: [...this.seenIds],
      pending,
      emittedAlive: this.emittedAlive,
      counts: this.counts,
      diagnostics: this.diagnostics,
      outputs: { statesBytes: this.statesBytes, lateBytes: this.lateBytes },
    };
  }

  loadSnapshot() {
    try {
      const raw = fs.readFileSync(this.snapshotPath, 'utf8');
      const snapshot = JSON.parse(raw);
      if (snapshot.version !== SNAPSHOT_VERSION) return null;
      return snapshot;
    } catch {
      return null;
    }
  }

  restore(snapshot) {
    this.linesRead = snapshot.linesRead;
    this.commits = snapshot.commits;
    this.maxTs = snapshot.maxTs;
    this.eof = false;
    this.restoredEof = snapshot.eof === true;
    this.samples = snapshot.samples;
    this.trips = snapshot.trips;
    this.retracted = new Set(snapshot.retracted);
    this.seenIds = new Set(snapshot.seenIds);
    this.pending = new Map();
    for (const event of snapshot.pending) {
      if (!this.pending.has(event.ts)) this.pending.set(event.ts, []);
      this.pending.get(event.ts).push(event);
    }
    this.emittedAlive = snapshot.emittedAlive;
    this.counts = snapshot.counts;
    this.diagnostics = snapshot.diagnostics;
    this.statesBytes = snapshot.outputs.statesBytes;
    this.lateBytes = snapshot.outputs.lateBytes;
    fs.truncateSync(this.statesPath, this.statesBytes);
    fs.truncateSync(this.latePath, this.lateBytes);
  }

  writeProof() {
    const tripRecords = this.emittedAlive.filter((rec) => rec.state === 'TRIP');
    const samples = this.activeSamples();
    const trips = tripRecords.map((rec) => {
      const evidence = (tag) =>
        samples
          .filter((s) => s.tag === tag && s.ts >= rec.since && s.ts <= rec.ts)
          .sort((a, b) => a.ts - b.ts || a.seq - b.seq)
          .map((s) => ({ id: s.id, ts: s.ts, value: s.value }));
      return {
        tripId: rec.tripId,
        channel: rec.channel,
        tripTs: rec.ts,
        armTs: rec.armTs,
        conditionStartTs: rec.since,
        heldMs: rec.ts - rec.since,
        pressureLimit: this.config.pressureLimit,
        tempLimit: this.config.tempLimit,
        durationMs: this.config.durationMs,
        evidence: {
          pressureSamples: evidence('pressure'),
          temperatureSamples: evidence('temperature'),
        },
      };
    });
    const proof = {
      version: SNAPSHOT_VERSION,
      conclusion:
        trips.length > 0 ? 'TRIP_CAUSED_BY_PT_COMBINATION' : 'NO_PROVEN_TRIP',
      config: {
        pressureTag: this.config.pressureTag,
        tempTag: this.config.tempTag,
        pressureLimit: this.config.pressureLimit,
        tempLimit: this.config.tempLimit,
        pressureUnit: this.config.pressureUnit,
        tempUnit: this.config.tempUnit,
        durationMs: this.config.durationMs,
        windowMs: this.config.windowMs,
        watermarkLagMs: this.config.watermarkLagMs,
      },
      maxEventTs: this.maxTs,
      commits: this.commits,
      counts: this.counts,
      diagnostics: this.diagnostics,
      trips,
    };
    fs.writeFileSync(this.proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  }
}
