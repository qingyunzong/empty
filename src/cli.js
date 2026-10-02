import fs from 'node:fs';
import path from 'node:path';
import { ReleaseEngine } from './engine.js';

const USAGE = `usage: fill release --in <dir> --out <dir>

Reads every *.jsonl file in --in (sorted by name, lines in file order = arrival
order) and writes into --out:
  batches.jsonl      final per-batch status
  transitions.jsonl  append-only, versioned state transitions
  comp.jsonl         compensation records (RELEASE -> HOLD rollbacks)
  late.log           events older than the watermark (max eventTs - 3min)
`;

function jsonl(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
}

export function run(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = [...argv];
  const cmd = args.shift();
  if (cmd !== 'release') {
    stderr.write(USAGE);
    return 2;
  }
  let inDir = null;
  let outDir = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--in') inDir = args[++i];
    else if (args[i] === '--out') outDir = args[++i];
    else { stderr.write(`unknown argument: ${args[i]}\n${USAGE}`); return 2; }
  }
  if (!inDir || !outDir) {
    stderr.write(USAGE);
    return 2;
  }

  const engine = new ReleaseEngine();
  let badLines = 0;
  const files = fs.readdirSync(inDir).filter((f) => f.endsWith('.jsonl')).sort();
  for (const file of files) {
    const text = fs.readFileSync(path.join(inDir, file), 'utf8');
    text.split('\n').forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        engine.process(JSON.parse(trimmed));
      } catch (err) {
        badLines += 1;
        stderr.write(`${err.code ?? 'PARSE_ERROR'} ${file}:${idx + 1}: ${err.message}\n`);
      }
    });
  }

  for (const e of engine.errors) {
    stderr.write(`${e.code} ${JSON.stringify(e)}\n`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const batches = engine.finalize();
  fs.writeFileSync(path.join(outDir, 'batches.jsonl'), jsonl(batches));
  fs.writeFileSync(path.join(outDir, 'transitions.jsonl'), jsonl(engine.transitions));
  fs.writeFileSync(path.join(outDir, 'comp.jsonl'), jsonl(engine.comps));
  fs.writeFileSync(path.join(outDir, 'late.log'), jsonl(engine.lates));

  const tally = { HOLD: 0, RELEASE: 0, REJECT: 0 };
  for (const b of batches) tally[b.status] += 1;
  stdout.write(
    `batches=${batches.length} RELEASE=${tally.RELEASE} HOLD=${tally.HOLD} REJECT=${tally.REJECT}`
    + ` transitions=${engine.transitions.length} compensations=${engine.comps.length}`
    + ` late=${engine.lates.length} errors=${engine.errors.length + badLines}\n`,
  );
  return badLines > 0 ? 1 : 0;
}
