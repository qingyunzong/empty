#!/usr/bin/env node
import fs from 'node:fs';
import { runMarginCall, SimulatedCrashError, MarginCallError } from './margin-call.js';

function fail(payload) {
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exit(1);
}

const [eventPath, logDir] = process.argv.slice(2);
if (!eventPath || !logDir) {
  fail({ error: 'USAGE', message: 'usage: node src/cli.js <event.json|-> <logDir>' });
}

let raw;
try {
  raw = eventPath === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(eventPath, 'utf8');
} catch (err) {
  fail({ error: 'EVENT_READ_FAILED', message: err.message });
}

let event;
try {
  event = JSON.parse(raw);
} catch (err) {
  fail({ error: 'EVENT_PARSE_FAILED', message: err.message });
}

try {
  const result = runMarginCall(event, logDir);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (err) {
  if (err instanceof SimulatedCrashError) {
    fail({ error: 'SIMULATED_CRASH', callId: err.callId, accountIndex: err.accountIndex, message: err.message });
  }
  if (err instanceof MarginCallError) {
    fail({ error: err.code, message: err.message });
  }
  fail({ error: 'INTERNAL', message: String((err && err.message) || err) });
}
