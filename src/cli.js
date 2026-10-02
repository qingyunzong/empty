import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseEvent } from './events.js';
import { Engine } from './engine.js';

const USAGE = `Usage: fill release --in <dir|file> --out <dir> [options]

Options:
  --density-min <g/mL>        lower density bound (default 0.95)
  --density-max <g/mL>        upper density bound (default 1.10)
  --watermark-lag-ms <ms>     watermark lag behind max event time (default 180000)
  -h, --help                  show this help

Outputs (in --out dir): batches.jsonl, transitions.jsonl, comp.jsonl, late.log`;

export function parseArgs(argv) {
  const args = { densityMin: undefined, densityMax: undefined, watermarkLagMs: undefined };
  const rest = [...argv];
  args.command = rest.shift();
  while (rest.length) {
    const a = rest.shift();
    switch (a) {
      case '--in': args.input = rest.shift(); break;
      case '--out': args.output = rest.shift(); break;
      case '--density-min': args.densityMin = Number(rest.shift()); break;
      case '--density-max': args.densityMax = Number(rest.shift()); break;
      case '--watermark-lag-ms': args.watermarkLagMs = Number(rest.shift()); break;
      case '-h': case '--help': args.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function inputFiles(p) {
  const st = statSync(p);
  if (st.isFile()) return [p];
  if (st.isDirectory()) {
    return readdirSync(p)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => path.join(p, f));
  }
  throw new Error(`--in is neither a file nor a directory: ${p}`);
}

function writeJsonl(file, rows) {
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

export function run(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.stderr.write(`error: ${e.message}\n\n${USAGE}\n`);
    return 1;
  }
  if (args.help || !args.command) {
    io.stdout.write(`${USAGE}\n`);
    return args.help ? 0 : 1;
  }
  if (args.command !== 'release' || !args.input || !args.output) {
    io.stderr.write(`error: "release" requires --in and --out\n\n${USAGE}\n`);
    return 1;
  }
  for (const k of ['densityMin', 'densityMax', 'watermarkLagMs']) {
    if (args[k] !== undefined && !Number.isFinite(args[k])) {
      io.stderr.write(`error: --${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())} must be a number\n`);
      return 1;
    }
  }

  const engine = new Engine({
    densityMin: args.densityMin,
    densityMax: args.densityMax,
    watermarkLagMs: args.watermarkLagMs,
  });

  let files;
  try {
    files = inputFiles(args.input);
  } catch (e) {
    io.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let event;
      try {
        event = parseEvent(line, `${file}:${i + 1}`);
      } catch (e) {
        io.stderr.write(`error: ${e.message}\n`);
        return 2;
      }
      engine.process(event);
    }
  }

  mkdirSync(args.output, { recursive: true });
  const batches = engine.summary();
  writeJsonl(path.join(args.output, 'batches.jsonl'), batches);
  writeJsonl(path.join(args.output, 'transitions.jsonl'), engine.transitions);
  writeJsonl(path.join(args.output, 'comp.jsonl'), engine.comp);
  writeJsonl(path.join(args.output, 'late.log'), engine.late);

  const counts = {};
  for (const b of batches) counts[b.state] = (counts[b.state] ?? 0) + 1;
  io.stdout.write(
    `processed ${engine.processed} events from ${files.length} file(s); ` +
    `batches=${batches.length} (${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}); ` +
    `transitions=${engine.transitions.length} comp=${engine.comp.length} late=${engine.late.length}\n`,
  );
  return 0;
}
