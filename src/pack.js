import fs from 'node:fs';
import { readEvents } from './events.js';
import { Processor, buildRelease } from './processor.js';
import {
  OUTBOX_FILES, appendWal, discardStaleOutbox, readWal, writeOutputs,
} from './store.js';

const jsonl = (rows) => (rows.length ? `${rows.map((r) => JSON.stringify(r)).join('\n')}\n` : '');

export function runPack(inDir, outDir, opts = {}) {
  const crashPoint = opts.crashPoint ?? null;
  fs.mkdirSync(outDir, { recursive: true });
  discardStaleOutbox(outDir);

  const events = readEvents(inDir); // validation (incl. HASH_BAD) fails before any state is written

  const proc = new Processor();
  const applied = new Set();
  for (const rec of readWal(outDir)) {
    proc.apply(rec.seq, rec.event);
    applied.add(rec.seq);
  }
  for (const { seq, event } of events) {
    if (applied.has(seq)) continue;
    if (proc.apply(seq, event) === 'applied') appendWal(outDir, seq, event);
  }

  const cases = proc.finalize();
  const release = buildRelease(cases, proc.watermark, proc.maxEventTs);
  const outputs = {
    'cases.jsonl': jsonl(cases),
    'release.json': `${JSON.stringify(release, null, 2)}\n`,
    'late.log': jsonl(proc.late),
  };
  writeOutputs(outDir, outputs, crashPoint);
  return { cases, release, late: proc.late, files: OUTBOX_FILES };
}
