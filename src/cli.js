import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseJsonl } from './parse.js';
import { analyze } from './engine.js';
import { TempRangeError, ParseError } from './errors.js';

const USAGE = `Usage: cold recall --in <dir> --out <dir> [options]

Options:
  --in <dir>            Directory containing input .jsonl event files (required)
  --out <dir>           Directory for output files (required)
  --max-c <celsius>     Temperature limit; readings above are anomalies (default -15)
  --lateness-ms <ms>    Allowed lateness behind the watermark (default 120000)
  --help                Show this help

Outputs: recall.json, evidence.jsonl, unexplained.jsonl, late.log
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function toNumber(value, name) {
  const num = Number(value);
  if (!Number.isFinite(num)) throw new ParseError(`--${name} must be a number, got "${value}"`);
  return num;
}

async function readInputEvents(inputDir) {
  let entries;
  try {
    entries = await readdir(inputDir, { withFileTypes: true });
  } catch (err) {
    throw new ParseError(`cannot read input directory ${inputDir}: ${err.message}`);
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => entry.name)
    .sort();
  const events = [];
  for (const file of files) {
    const text = await readFile(path.join(inputDir, file), 'utf8');
    for (const event of parseJsonl(text, file)) events.push(event);
  }
  return events;
}

function windowRecord(window) {
  const record = {
    zone: window.zone,
    start: window.start,
    end: window.end,
    maxC: window.maxC,
    readings: window.readings,
    lots: window.lots,
  };
  return record;
}

export async function runRecall(args) {
  const inputDir = args.in;
  const outputDir = args.out;
  if (!inputDir || !outputDir) throw new ParseError('both --in and --out are required');

  const options = {};
  if (args['max-c'] !== undefined) options.maxC = toNumber(args['max-c'], 'max-c');
  if (args['lateness-ms'] !== undefined) options.allowedLatenessMs = toNumber(args['lateness-ms'], 'lateness-ms');

  const events = await readInputEvents(inputDir);
  const result = analyze(events, options);

  await mkdir(outputDir, { recursive: true });

  const recallJson = {
    generatedAt: new Date().toISOString(),
    watermark: result.watermark,
    maxEventTs: result.maxEventTs,
    config: result.config,
    counts: result.counts,
    minimalSize: result.recall.minimalSize,
    exact: result.recall.exact,
    lots: result.recall.lots,
    solutions: result.recall.solutions,
    uncoveredWindows: result.uncoveredWindows.map(windowRecord),
  };

  const evidenceLines = result.evidence.map((record) => JSON.stringify(record));
  const unexplainedLines = result.unexplained.map((window) => JSON.stringify(windowRecord(window)));
  const lateLines = result.late.map(({ event, watermark }) =>
    JSON.stringify({ reason: 'late-event', eventTs: event.eventTs, watermark, event }));

  await Promise.all([
    writeFile(path.join(outputDir, 'recall.json'), `${JSON.stringify(recallJson, null, 2)}\n`),
    writeFile(path.join(outputDir, 'evidence.jsonl'), evidenceLines.length ? `${evidenceLines.join('\n')}\n` : ''),
    writeFile(path.join(outputDir, 'unexplained.jsonl'), unexplainedLines.length ? `${unexplainedLines.join('\n')}\n` : ''),
    writeFile(path.join(outputDir, 'late.log'), lateLines.length ? `${lateLines.join('\n')}\n` : ''),
  ]);

  return result;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = parseArgs(argv);
  const command = args._[0];

  if (args.help || command === undefined) {
    stdout.write(USAGE);
    return command === undefined && !args.help ? 1 : 0;
  }
  if (command !== 'recall') {
    stderr.write(`unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }

  try {
    const result = await runRecall(args);
    stdout.write(
      `recall complete: ${result.recall.minimalSize} lot(s), ` +
        `${result.recall.solutions.length} solution(s), ` +
        `${result.counts.unexplainedWindows} unexplained window(s), ` +
        `${result.counts.lateEvents} late event(s)\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof TempRangeError) {
      stderr.write(`TEMP_RANGE: ${err.message}\n`);
      return 1;
    }
    if (err instanceof ParseError) {
      stderr.write(`PARSE_ERROR: ${err.message}\n`);
      return 1;
    }
    stderr.write(`ERROR: ${err.message}\n`);
    return 1;
  }
}
