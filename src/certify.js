import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from './engine.js';

export function collect(engine) {
  return {
    certs: engine.certLog,
    voids: engine.voids,
    late: engine.late,
    errors: engine.errors,
    final: [...engine.finalCerts().values()],
  };
}

// Pure in-memory entry point: apply raw event objects in the given order.
export function certifyEvents(rawEvents, options = {}) {
  const engine = new Engine(options);
  rawEvents.forEach((raw, i) => engine.apply(raw, { line: i + 1 }));
  return collect(engine);
}

function writeJsonl(path, rows) {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

function formatLate(entry) {
  return (
    `LATE type=${entry.type} id=${entry.id ?? '-'} eventTs=${entry.eventTs} ` +
    `watermark=${entry.watermark} src=${entry.file ?? '-'}:${entry.line ?? '-'}`
  );
}

// Batch entry point: read every *.jsonl file in `inDir` (sorted by name),
// apply events in file/line order, write certs.jsonl / void.jsonl / late.log /
// errors.jsonl into `outDir`.
export function certifyDir(inDir, outDir, options = {}) {
  const engine = new Engine(options);
  const files = readdirSync(inDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  for (const file of files) {
    const text = readFileSync(join(inDir, file), 'utf8');
    text.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      let raw;
      try {
        raw = JSON.parse(line);
      } catch {
        engine.errors.push({ code: 'INVALID_JSON', file, line: i + 1, message: line.slice(0, 120) });
        return;
      }
      engine.apply(raw, { file, line: i + 1 });
    });
  }
  const result = collect(engine);
  mkdirSync(outDir, { recursive: true });
  writeJsonl(join(outDir, 'certs.jsonl'), result.certs);
  writeJsonl(join(outDir, 'void.jsonl'), result.voids);
  writeJsonl(join(outDir, 'errors.jsonl'), result.errors);
  writeFileSync(
    join(outDir, 'late.log'),
    result.late.map(formatLate).join('\n') + (result.late.length ? '\n' : ''),
  );
  return result;
}
