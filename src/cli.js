import { readdirSync, readFileSync, mkdirSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { Engine, parseEvent, AgvError, DEFAULT_LAG_MS } from './engine.js';

const EXIT_CODES = { DUP_RESERVE: 2, UNKNOWN_AGV: 3 };

const USAGE =
  'usage: agv deadlock --in <dir> --out <dir> [--lag-ms <ms>]\n';

function stderrSync(msg) {
  writeSync(2, msg);
}

function parseArgs(argv) {
  const out = { command: argv[0], lagMs: DEFAULT_LAG_MS, inDir: null, outDir: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    let k;
    let v;
    if (eq >= 0) {
      k = a.slice(0, eq);
      v = a.slice(eq + 1);
    } else {
      k = a;
      v = argv[++i];
    }
    if (k === '--in') out.inDir = v;
    else if (k === '--out') out.outDir = v;
    else if (k === '--lag-ms') out.lagMs = Number(v);
    else throw new AgvError('BAD_ARGS', `unknown argument ${JSON.stringify(k)}`);
  }
  return out;
}

function serializeWait(w) {
  return JSON.stringify({
    from: w.from,
    to: w.to,
    start: w.start,
    end: w.end === Infinity ? null : w.end,
    reserveId: w.reserveId,
    pingId: w.pingId,
  });
}

function jsonl(rows, serialize) {
  if (rows.length === 0) return '';
  return rows.map(serialize).join('\n') + '\n';
}

export async function run(argv) {
  try {
    const args = parseArgs(argv);
    if (args.command !== 'deadlock' || !args.inDir || !args.outDir) {
      stderrSync(USAGE);
      return 1;
    }
    if (!Number.isFinite(args.lagMs) || args.lagMs < 0) {
      throw new AgvError('BAD_ARGS', `--lag-ms must be a non-negative number, got ${args.lagMs}`);
    }

    const engine = new Engine({ lagMs: args.lagMs });
    const files = readdirSync(args.inDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
    let lineno = 0;
    for (const f of files) {
      const text = readFileSync(join(args.inDir, f), 'utf8');
      for (const line of text.split('\n')) {
        lineno += 1;
        if (!line.trim()) continue;
        engine.ingest(parseEvent(line, lineno));
      }
    }

    mkdirSync(args.outDir, { recursive: true });
    writeFileSync(join(args.outDir, 'cycles.json'), JSON.stringify(engine.emitted, null, 2) + '\n');
    writeFileSync(join(args.outDir, 'waits.jsonl'), jsonl(engine.waits, serializeWait));
    writeFileSync(join(args.outDir, 'invalid.jsonl'), jsonl(engine.invalidated, (r) => JSON.stringify(r)));
    writeFileSync(join(args.outDir, 'late.log'), engine.late.length ? engine.late.join('\n') + '\n' : '');
    return 0;
  } catch (err) {
    if (err instanceof AgvError) {
      stderrSync(`ERROR ${err.code}: ${err.message}\n`);
      return EXIT_CODES[err.code] ?? 1;
    }
    throw err;
  }
}
