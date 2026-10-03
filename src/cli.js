#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { WindowEngine } from './engine.js';

const USAGE = 'usage: node src/cli.js windows --in <samples.jsonl>';

function fatal(record) {
  process.stderr.write(JSON.stringify(record) + '\n');
  process.exit(2);
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] !== 'windows') return null;
  let input = null;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--in' && i + 1 < argv.length) {
      input = argv[i + 1];
      i += 1;
    } else {
      return null;
    }
  }
  return input ? { input } : null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return 'event must be a JSON object';
  }
  switch (event.type) {
    case 'UPSERT':
      if (!isNonEmptyString(event.sensorId)) return 'UPSERT.sensorId must be a non-empty string';
      if (!isNonEmptyString(event.sampleId)) return 'UPSERT.sampleId must be a non-empty string';
      if (!isFiniteNumber(event.ts)) return 'UPSERT.ts must be a finite number (epoch ms)';
      if (!isFiniteNumber(event.temp)) return 'UPSERT.temp must be a finite number';
      return null;
    case 'RETRACT':
      if (!isNonEmptyString(event.sensorId)) return 'RETRACT.sensorId must be a non-empty string';
      if (!isNonEmptyString(event.sampleId)) return 'RETRACT.sampleId must be a non-empty string';
      return null;
    case 'WATERMARK':
      if (!isFiniteNumber(event.ts)) return 'WATERMARK.ts must be a finite number (epoch ms)';
      if (event.sensorId !== undefined && !isNonEmptyString(event.sensorId)) {
        return 'WATERMARK.sensorId, when present, must be a non-empty string';
      }
      return null;
    default:
      return `unknown event type: ${JSON.stringify(event.type ?? null)}`;
  }
}

export function run(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = parseArgs(argv);
  if (!args) {
    stderr.write(JSON.stringify({ error: 'USAGE', message: USAGE }) + '\n');
    return 2;
  }
  let content;
  try {
    content = readFileSync(args.input, 'utf8');
  } catch (err) {
    stderr.write(JSON.stringify({ error: 'INPUT_UNREADABLE', path: args.input, message: err.message }) + '\n');
    return 2;
  }
  const engine = new WindowEngine();
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      stderr.write(JSON.stringify({ error: 'INVALID_JSON', line: index + 1 }) + '\n');
      return 2;
    }
    const problem = validateEvent(event);
    if (problem) {
      stderr.write(JSON.stringify({ error: 'INVALID_EVENT', line: index + 1, message: problem }) + '\n');
      return 2;
    }
    const { outputs, errors } = engine.ingest(event);
    for (const output of outputs) stdout.write(JSON.stringify(output) + '\n');
    for (const error of errors) stderr.write(JSON.stringify({ line: index + 1, ...error }) + '\n');
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run(process.argv.slice(2)));
}
