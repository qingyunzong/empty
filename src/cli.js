'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  parseJsonl,
  runEngine,
  DEFAULT_RATED_FORCE,
  DEFAULT_WATERMARK_DELAY_MS,
} = require('./engine');

const USAGE = [
  'usage: tool life --in <dir> --out <dir> [--rated-force N] [--watermark-delay-ms N]',
  '',
  '  reads every *.jsonl file in <dir> (sorted by name) as the event stream,',
  '  writes tools.jsonl, parts.jsonl, risk.json and late.log into <dir-out>.',
].join('\n');

function parseArgs(argv) {
  const opts = { ratedForce: DEFAULT_RATED_FORCE, watermarkDelayMs: DEFAULT_WATERMARK_DELAY_MS };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[i];
    };
    if (a === '--in') opts.inDir = next();
    else if (a === '--out') opts.outDir = next();
    else if (a === '--rated-force') opts.ratedForce = Number(next());
    else if (a === '--watermark-delay-ms') opts.watermarkDelayMs = Number(next());
    else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
    else positional.push(a);
  }
  return { command: positional[0], opts };
}

function formatError(err) {
  switch (err.code) {
    case 'LIFE_INVALID':
      return `LIFE_INVALID tool=${err.tool} op=${err.op} newLife=${err.newLife}`;
    case 'RETRACT_MISS':
      return `RETRACT_MISS kind=${err.kind} id=${err.id}`;
    case 'PARSE_ERROR':
      return `PARSE_ERROR line=${err.line} reason=${err.reason}`;
    case 'EVENT_INVALID':
      return `EVENT_INVALID line=${err.line} reason=${err.reason}`;
    default:
      return `${err.code} ${JSON.stringify(err)}`;
  }
}

// Runs the `life` subcommand. Returns the process exit code.
function life(opts, io = { stdout: process.stdout, stderr: process.stderr }) {
  if (!opts.inDir || !opts.outDir) {
    io.stderr.write(USAGE + '\n');
    return 2;
  }
  if (!Number.isFinite(opts.ratedForce) || opts.ratedForce <= 0) {
    io.stderr.write('error: --rated-force must be a number > 0\n');
    return 2;
  }
  if (!Number.isFinite(opts.watermarkDelayMs) || opts.watermarkDelayMs < 0) {
    io.stderr.write('error: --watermark-delay-ms must be a number >= 0\n');
    return 2;
  }

  let files;
  try {
    files = fs
      .readdirSync(opts.inDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
  } catch (err) {
    io.stderr.write(`error: cannot read input dir: ${err.message}\n`);
    return 2;
  }

  const events = [];
  const parseErrors = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(opts.inDir, f), 'utf8');
    const parsed = parseJsonl(text);
    for (const e of parsed.errors) parseErrors.push({ ...e, file: f });
    events.push(...parsed.events);
  }

  const result = runEngine(events, {
    ratedForce: opts.ratedForce,
    watermarkDelayMs: opts.watermarkDelayMs,
  });
  result.errors.unshift(...parseErrors);
  result.risk.errors = result.errors;

  fs.mkdirSync(opts.outDir, { recursive: true });
  const write = (name, content) => fs.writeFileSync(path.join(opts.outDir, name), content);
  write('tools.jsonl', result.tools.map((t) => JSON.stringify(t)).join('\n') + (result.tools.length ? '\n' : ''));
  write('parts.jsonl', result.parts.map((p) => JSON.stringify(p)).join('\n') + (result.parts.length ? '\n' : ''));
  write('risk.json', JSON.stringify(result.risk, null, 2) + '\n');
  write(
    'late.log',
    result.late
      .map((l) => `LATE kind=${l.kind} id=${l.id} eventTs=${l.eventTs} watermark=${l.watermark}`)
      .join('\n') + (result.late.length ? '\n' : '')
  );

  for (const err of result.errors) io.stderr.write(formatError(err) + '\n');
  const c = result.risk.counts;
  io.stdout.write(
    `events=${events.length} tools=${result.tools.length} parts=${result.parts.length} ` +
      `GOOD=${c.GOOD} BAD=${c.BAD} UNKNOWN=${c.UNKNOWN} RISK=${c.RISK} ` +
      `late=${result.late.length} errors=${result.errors.length}\n`
  );
  return 0;
}

function main(argv, io) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    (io || { stderr: process.stderr }).stderr.write(`error: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  if (parsed.command === 'life') return life(parsed.opts, io);
  (io || { stderr: process.stderr }).stderr.write(USAGE + '\n');
  return 2;
}

module.exports = { main, life, parseArgs, formatError, USAGE };
