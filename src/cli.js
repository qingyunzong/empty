import fs from 'node:fs';
import path from 'node:path';
import { parseEvent, PlanError } from './events.js';
import { runPipeline } from './pipeline.js';

const USAGE = 'usage: plan run --in <dir> --out <dir>';

export function main(argv) {
  const args = [...argv];
  if (args[0] !== 'run') {
    console.error(USAGE);
    return 2;
  }
  let inDir = null;
  let outDir = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--in') inDir = args[++i];
    else if (args[i] === '--out') outDir = args[++i];
    else {
      console.error(USAGE);
      return 2;
    }
  }
  if (!inDir || !outDir) {
    console.error(USAGE);
    return 2;
  }

  let events;
  try {
    events = readEvents(inDir);
  } catch (e) {
    if (e instanceof PlanError) {
      writeError(outDir, e.code, e.message);
      return 1;
    }
    throw e;
  }

  const result = runPipeline(events);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'schedule.json'),
    JSON.stringify(
      {
        horizonStart: result.horizonStart,
        horizonEnd: result.horizonEnd,
        watermark: result.watermark,
        objective: result.best.objective,
        ties: result.best.sequences.length,
        sequences: result.best.sequences,
      },
      null,
      2,
    ) + '\n',
  );
  fs.writeFileSync(path.join(outDir, 'corrections.json'), JSON.stringify(result.corrections, null, 2) + '\n');
  fs.writeFileSync(
    path.join(outDir, 'late.log'),
    result.late.map((l) => JSON.stringify(l)).join('\n') + (result.late.length ? '\n' : ''),
  );
  return 0;
}

function readEvents(inDir) {
  let names;
  try {
    names = fs.readdirSync(inDir);
  } catch {
    throw new PlanError('INPUT_NOT_FOUND', `cannot read input directory: ${inDir}`);
  }
  const files = names.filter((n) => n.endsWith('.jsonl')).sort();
  const events = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(inDir, f), 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i].trim();
      if (!s) continue;
      events.push(parseEvent(s, `${f}:${i + 1}`));
    }
  }
  return events;
}

function writeError(outDir, code, msg) {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'error.json'), JSON.stringify({ code, msg }, null, 2) + '\n');
  } catch {
    console.error(`${code}: ${msg}`);
  }
}
