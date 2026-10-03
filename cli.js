#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { FrameDecoder, FrameError } from './src/frame.js';
import { Engine, UnknownOrigError } from './src/engine.js';
import { prepareFrames, DuplicateConflictError } from './src/runner.js';
import { crc32 } from './src/crc32.js';
import { canonical } from './src/canon.js';

const USAGE = `usage:
  node cli.js [--config config.json] [--window N] <in.jsonl>
  node cli.js --crc '<frame-json-without-crc>'

exit codes: 0 ok | 2 frame error | 3 unknown origId | 4 duplicate clOrdId conflict`;

function die(msg, code) {
  console.error(`cli: ${msg}`);
  process.exit(code);
}

const args = process.argv.slice(2);
let configPath = null;
let windowArg = null;
let crcArg = null;
let input = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--config') configPath = args[++i];
  else if (a === '--window') windowArg = args[++i];
  else if (a === '--crc') crcArg = args[++i];
  else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
  else if (a.startsWith('--')) die(`unknown option: ${a}`, 1);
  else if (input === null) input = a;
  else die(`unexpected argument: ${a}`, 1);
}

if (crcArg !== null) {
  let obj;
  try {
    obj = JSON.parse(crcArg);
  } catch (e) {
    die(`--crc: invalid JSON: ${e.message}`, 2);
  }
  delete obj.crc;
  obj.crc = crc32(canonical(obj));
  console.log(JSON.stringify(obj));
  process.exit(0);
}

if (!input) die(USAGE, 1);

let config = {};
if (configPath) {
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    die(`cannot read config: ${e.message}`, 2);
  }
}
if (windowArg !== null) {
  const w = Number(windowArg);
  if (!Number.isInteger(w) || w < 0) die(`--window must be a non-negative integer`, 1);
  config.window = w;
}

let data;
try {
  data = readFileSync(input, 'utf8');
} catch (e) {
  die(`cannot read input: ${e.message}`, 2);
}

const decoder = new FrameDecoder();
let frames;
try {
  frames = [...decoder.push(data), ...decoder.end()];
} catch (e) {
  if (e instanceof FrameError) die(e.message, 2);
  throw e;
}

let ordered;
try {
  ordered = prepareFrames(frames);
} catch (e) {
  if (e instanceof DuplicateConflictError) die(e.message, 4);
  throw e;
}

const engine = new Engine(config);
let printed = 0;
const drain = () => {
  for (; printed < engine.events.length; printed++) console.log(JSON.stringify(engine.events[printed]));
};
try {
  for (const frame of ordered) {
    engine.apply(frame);
    drain();
  }
} catch (e) {
  if (e instanceof UnknownOrigError) {
    drain();
    die(e.message, 3);
  }
  throw e;
}
engine.finish();
drain();
console.log(JSON.stringify({ type: 'audit', events: engine.events.length, root: engine.auditRoot() }));
