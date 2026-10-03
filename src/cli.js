import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processEvents, ColdError } from './parse.js';
import { analyze, DEFAULTS } from './analyze.js';

export function readJsonlDir(inDir) {
  let names;
  try {
    names = readdirSync(inDir);
  } catch {
    throw new ColdError('NO_INPUT', `cannot read input dir: ${inDir}`);
  }
  const raws = [];
  for (const name of names.filter((n) => n.endsWith('.jsonl')).sort()) {
    const text = readFileSync(join(inDir, name), 'utf8');
    text.split(/\r?\n/).forEach((line, idx) => {
      if (!line.trim()) return;
      try {
        raws.push(JSON.parse(line));
      } catch (err) {
        throw new ColdError('BAD_JSON', `${name}:${idx + 1}: ${err.message}`);
      }
    });
  }
  return raws;
}

export function runRecall({ inDir, outDir, minC, maxC, shortWindowMs, watermarkLagMs }) {
  const raws = readJsonlDir(inDir);
  const { events, late, watermark } = processEvents(raws, { watermarkLagMs });
  const result = analyze(events, { minC, maxC, shortWindowMs, watermark });

  mkdirSync(outDir, { recursive: true });

  const recall = {
    watermark,
    thresholds: { minC, maxC },
    minimumSize: result.cover.minimumSize,
    solutions: result.cover.solutions,
    exposedLots: result.exposedLots,
    unexplainedWindows: result.unexplained.length,
  };
  writeFileSync(join(outDir, 'recall.json'), JSON.stringify(recall, null, 2) + '\n');

  const evidenceLines = [];
  for (const w of result.explained) {
    evidenceLines.push(JSON.stringify({
      type: 'explained',
      zone: w.zone,
      windowStart: w.start,
      windowEnd: w.end,
      durationMs: w.durationMs,
      reason: 'door-open',
      doorOpenStart: w.doorStart,
      doorOpenEnd: w.doorEnd,
    }));
  }
  for (const e of result.exposures) {
    evidenceLines.push(JSON.stringify({ type: 'exposure', ...e }));
  }
  writeFileSync(join(outDir, 'evidence.jsonl'), evidenceLines.length ? evidenceLines.join('\n') + '\n' : '');

  const unexplainedLines = result.unexplained.map((w) => JSON.stringify({
    zone: w.zone,
    start: w.start,
    end: w.end,
    durationMs: w.durationMs,
    exposedLots: w.exposedLots,
  }));
  writeFileSync(join(outDir, 'unexplained.jsonl'), unexplainedLines.length ? unexplainedLines.join('\n') + '\n' : '');

  writeFileSync(join(outDir, 'late.log'), late.length ? late.join('\n') + '\n' : '');

  return { recall, result, late };
}

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new ColdError('USAGE', `unexpected argument: ${arg}`);
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new ColdError('USAGE', `missing value for --${key}`);
    opts[key] = value;
  }
  if (!opts.in || !opts.out) throw new ColdError('USAGE', 'required: --in <dir> --out <dir>');
  const num = (v, fallback) => (v === undefined ? fallback : Number(v));
  const parsed = {
    inDir: opts.in,
    outDir: opts.out,
    minC: num(opts['min-c'], DEFAULTS.minC),
    maxC: num(opts['max-c'], DEFAULTS.maxC),
    shortWindowMs: num(opts['short-window-ms'], DEFAULTS.shortWindowMs),
    watermarkLagMs: num(opts['watermark-lag-ms'], undefined),
  };
  for (const k of ['minC', 'maxC', 'shortWindowMs', 'watermarkLagMs']) {
    if (parsed[k] !== undefined && !Number.isFinite(parsed[k])) {
      throw new ColdError('USAGE', `invalid numeric option: ${k}`);
    }
  }
  if (parsed.watermarkLagMs === undefined) delete parsed.watermarkLagMs;
  return parsed;
}

export function main(argv, io = {}) {
  const stdout = io.stdout ?? ((s) => console.log(s));
  const stderr = io.stderr ?? ((s) => console.error(s));
  const [command, ...rest] = argv;
  if (command !== 'recall') {
    stderr('usage: cold recall --in <dir> --out <dir> [--min-c N] [--max-c N] [--short-window-ms N] [--watermark-lag-ms N]');
    return command === undefined ? 0 : 1;
  }
  try {
    const opts = parseArgs(rest);
    const { recall } = runRecall(opts);
    stdout(`watermark=${recall.watermark} unexplained=${recall.unexplainedWindows} minimumSize=${recall.minimumSize} solutions=${JSON.stringify(recall.solutions)}`);
    return 0;
  } catch (err) {
    if (err instanceof ColdError) {
      stderr(`${err.code}: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
