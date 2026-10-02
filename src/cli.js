import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { DispatchError } from './errors.js';

const USAGE = 'usage: dispatch solve --in <dir|file.jsonl> --out <dir>';

function parseArgs(argv) {
  if (argv[0] !== 'solve') throw new DispatchError('USAGE', USAGE);
  const opts = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--in') opts.in = argv[++i];
    else if (argv[i] === '--out') opts.out = argv[++i];
    else throw new DispatchError('USAGE', `unknown argument "${argv[i]}"\n${USAGE}`);
  }
  if (!opts.in || !opts.out) throw new DispatchError('USAGE', USAGE);
  return opts;
}

function inputFiles(p) {
  const st = statSync(p);
  if (st.isFile()) return [p];
  return readdirSync(p)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => join(p, f));
}

export function run(argv) {
  const opts = parseArgs(argv);
  const engine = new Engine();
  for (const file of inputFiles(opts.in)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        throw new DispatchError('INPUT_INVALID', `${file}:${idx + 1}: invalid JSON`);
      }
      engine.ingest(obj, `${file}:${idx + 1}`);
    });
  }
  const out = engine.finalize();
  mkdirSync(opts.out, { recursive: true });
  writeFileSync(join(opts.out, 'plan.json'), out.plan);
  writeFileSync(join(opts.out, 'budget.json'), out.budget);
  writeFileSync(join(opts.out, 'rework.jsonl'), out.rework);
  writeFileSync(join(opts.out, 'late.log'), out.late);
  return 0;
}

export function main(argv) {
  try {
    return run(argv);
  } catch (err) {
    if (err instanceof DispatchError) {
      console.error(`ERROR ${err.code}: ${err.message}`);
      return err.code === 'USAGE' ? 64 : 2;
    }
    console.error(`ERROR INTERNAL: ${err.message}`);
    return 2;
  }
}
