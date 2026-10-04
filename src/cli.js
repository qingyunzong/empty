#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SessionProcessor, normalizeRecord } from './sessions.js';

const USAGE = 'Usage: node src/cli.js sessions --in <data.jsonl>';

function writeStderr(payload) {
  process.stderr.write(JSON.stringify(payload) + '\n');
}

function fatal(payload) {
  writeStderr({ fatal: true, ...payload });
  return 2;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'sessions') return null;
  let inPath = null;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--in' && i + 1 < rest.length) {
      inPath = rest[i + 1];
      i += 1;
    } else {
      return null;
    }
  }
  return inPath === null ? null : { inPath };
}

export function run(argv) {
  const args = parseArgs(argv);
  if (args === null) {
    return fatal({ error: 'USAGE', message: USAGE });
  }
  let text;
  try {
    text = readFileSync(args.inPath, 'utf8');
  } catch (cause) {
    return fatal({ error: 'IO', message: `cannot read ${args.inPath}: ${cause.message}` });
  }
  const processor = new SessionProcessor();
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '') continue;
    const lineNo = index + 1;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (cause) {
      return fatal({ error: 'INVALID_JSON', line: lineNo, message: cause.message });
    }
    let record;
    try {
      record = normalizeRecord(raw);
    } catch (cause) {
      return fatal({ error: 'INVALID_RECORD', line: lineNo, message: cause.message });
    }
    const { emitted, error } = processor.process(record);
    if (error !== null) {
      writeStderr({ error: error.code, message: error.message, line: lineNo, record: raw });
    }
    for (const session of emitted) {
      process.stdout.write(JSON.stringify(session) + '\n');
    }
  }
  return 0;
}

const invokedAsMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsMain) {
  process.exitCode = run(process.argv.slice(2));
}
