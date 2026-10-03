// Crash-safe persistence: events are appended to wal.jsonl (fsync per record)
// before any output exists. Outputs are written as a single outbox.tmp bundle
// and only then materialized to cases.jsonl / release.json / late.log.
// Fault point: crash after outbox.tmp is written but before materialization.
// Recovery: discard the half-written outbox.tmp, replay wal.jsonl, regenerate.
// Result is byte-identical to a no-fault run (no wall clock anywhere).

import fs from 'node:fs';
import path from 'node:path';
import { Engine, render } from './engine.js';

export const OUTPUT_FILES = ['cases.jsonl', 'release.json', 'late.log'];

export function readEvents(inDir) {
  let files;
  if (fs.existsSync(path.join(inDir, 'events.jsonl'))) {
    files = ['events.jsonl'];
  } else {
    files = fs.readdirSync(inDir).filter((f) => f.endsWith('.jsonl')).sort();
  }
  const events = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(inDir, f), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim()) events.push(JSON.parse(line));
    }
  }
  return events;
}

export function run({ inDir, outDir, crashAt = null, exit = (code) => process.exit(code) }) {
  fs.mkdirSync(outDir, { recursive: true });
  const walPath = path.join(outDir, 'wal.jsonl');
  const tmpPath = path.join(outDir, 'outbox.tmp');

  // Recovery step 1: a leftover outbox.tmp is a half-written outbox. Discard it.
  if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath);

  // Ingest: append any not-yet-logged input events to the WAL (idempotent).
  const events = readEvents(inDir);
  const walCount = fs.existsSync(walPath)
    ? fs.readFileSync(walPath, 'utf8').split('\n').filter(Boolean).length
    : 0;
  if (walCount > events.length) throw new Error('WAL_LONGER_THAN_INPUT');
  if (walCount < events.length) {
    const fd = fs.openSync(walPath, 'a');
    try {
      for (let i = walCount; i < events.length; i++) {
        fs.writeSync(fd, JSON.stringify({ seq: i + 1, event: events[i] }) + '\n');
        fs.fsyncSync(fd);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  // Replay the WAL from scratch: state equals the no-fault run by construction.
  const engine = new Engine();
  for (const line of fs.readFileSync(walPath, 'utf8').split('\n')) {
    if (line.trim()) engine.apply(JSON.parse(line).event);
  }
  const out = render(engine);

  // Write the outbox bundle, then materialize. Crash between the two is the
  // defined fault point and is safe: the tmp file is discarded on recovery.
  const bundle = JSON.stringify({ cases: out.cases, release: out.release, late: out.late });
  fs.writeFileSync(tmpPath, bundle);
  if (crashAt === 'before-rename') exit(42);

  const materialized = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
  fs.writeFileSync(path.join(outDir, 'cases.jsonl'), materialized.cases);
  fs.writeFileSync(path.join(outDir, 'release.json'), materialized.release);
  fs.writeFileSync(path.join(outDir, 'late.log'), materialized.late);
  fs.rmSync(tmpPath);
  if (crashAt === 'after-rename') exit(42);

  return out;
}
