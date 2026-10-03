'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const { Engine, toEpochMs } = require('./engine.js');

const USAGE = 'node src/cli.js profiles --in <file.jsonl>';

class CliError extends Error {
  constructor(message, extra) {
    super(message);
    this.extra = extra || {};
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args[0] !== 'profiles') {
    throw new CliError('unknown command', { usage: USAGE });
  }
  let input = null;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--in') {
      input = args[i + 1];
      i += 1;
    } else {
      throw new CliError('unknown argument', { argument: args[i] });
    }
  }
  if (!input) {
    throw new CliError('missing --in <file.jsonl>', { usage: USAGE });
  }
  return { input };
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateEvent(event, lineNo) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new CliError('event must be a JSON object', { line: lineNo });
  }
  if (typeof event.profileId !== 'string' || event.profileId.length === 0) {
    throw new CliError('event.profileId must be a non-empty string', { line: lineNo });
  }
  switch (event.type) {
    case 'UPSERT':
      if (!isFiniteNumber(event.depth)) throw new CliError('UPSERT.depth must be a number', { line: lineNo });
      if (!isFiniteNumber(event.temp)) throw new CliError('UPSERT.temp must be a finite number', { line: lineNo });
      if (!Number.isInteger(event.version) || event.version < 0) {
        throw new CliError('UPSERT.version must be a non-negative integer', { line: lineNo });
      }
      if (toEpochMs(event.eventTime) === null) {
        throw new CliError('UPSERT.eventTime must be epoch ms or ISO 8601 string', { line: lineNo });
      }
      break;
    case 'RETRACT':
      if (!isFiniteNumber(event.depth)) throw new CliError('RETRACT.depth must be a number', { line: lineNo });
      if (!Number.isInteger(event.version) || event.version < 0) {
        throw new CliError('RETRACT.version must be a non-negative integer', { line: lineNo });
      }
      if (toEpochMs(event.eventTime) === null) {
        throw new CliError('RETRACT.eventTime must be epoch ms or ISO 8601 string', { line: lineNo });
      }
      break;
    case 'WATERMARK':
      if (toEpochMs(event.time) === null) {
        throw new CliError('WATERMARK.time must be epoch ms or ISO 8601 string', { line: lineNo });
      }
      break;
    default:
      throw new CliError('unknown event type', { line: lineNo, type: event.type });
  }
}

async function run(argv, io) {
  try {
    const { input } = parseArgs(argv);
    let stat;
    try {
      stat = fs.statSync(input);
    } catch (err) {
      throw new CliError('cannot open input file', { file: input, detail: err.message });
    }
    if (!stat.isFile()) {
      throw new CliError('input is not a regular file', { file: input });
    }
    const stream = fs.createReadStream(input, { encoding: 'utf8' });
    let streamError = null;
    stream.on('error', (err) => {
      streamError = err;
    });

    const engine = new Engine();
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNo = 0;
    for await (const line of rl) {
      lineNo += 1;
      if (line.trim() === '') continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (err) {
        throw new CliError('invalid JSON line', { line: lineNo, detail: err.message });
      }
      validateEvent(event, lineNo);
      const result = engine.apply(event);
      if (result) io.stdout(JSON.stringify(result));
    }
    if (streamError) {
      throw new CliError('cannot read input file', { file: input, detail: streamError.message });
    }
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr(JSON.stringify(Object.assign({ error: err.message }, err.extra)));
      return 2;
    }
    io.stderr(JSON.stringify({ error: 'unexpected failure', detail: err.message }));
    return 2;
  }
}

if (require.main === module) {
  run(process.argv, {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  }).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { run };
