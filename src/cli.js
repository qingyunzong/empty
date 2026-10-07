#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { ClearingHouse } from './engine.js';

const USAGE = `Usage: clearing [input.json] [--pretty]

Reads a JSON job from a file argument or stdin and prints a JSON report.

Input schema:
{
  "config":      { "slots": 3, "capacity": 1, "quotas": { "INST": 2 }, "agingFactor": 1 },
  "instructions": [ { "id", "institution", "amount", "priority", "deadline", "deps": [], "age": 0 } ],
  "undo":         [ { "id": "x", "expectedVersion": 2 } ]
}

Output: { "version", "schedule", "waitlist", "orphans", "certificates", "errors" }
Exit code is 2 whenever the errors array is non-empty or the input is invalid.`;

function emit(payload, pretty, exitCode) {
  process.stdout.write(`${JSON.stringify(payload, null, pretty ? 2 : 0)}\n`);
  process.exitCode = exitCode;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  let pretty = false;
  let file = null;
  for (const arg of args) {
    if (arg === '--pretty') pretty = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`);
      return;
    } else if (file === null) file = arg;
    else {
      emit({ errors: [{ code: 'INVALID_INPUT', message: `unexpected argument: ${arg}` }] }, pretty, 2);
      return;
    }
  }
  let text;
  try {
    text = file ? readFileSync(file, 'utf8') : await readStdin();
  } catch (err) {
    emit({ errors: [{ code: 'INVALID_INPUT', message: `cannot read input: ${err.message}` }] }, pretty, 2);
    return;
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    emit({ errors: [{ code: 'INVALID_INPUT', message: `invalid JSON: ${err.message}` }] }, pretty, 2);
    return;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    emit({ errors: [{ code: 'INVALID_INPUT', message: 'top-level JSON value must be an object' }] }, pretty, 2);
    return;
  }
  const allErrors = [];
  let house;
  try {
    house = new ClearingHouse(payload.config ?? {});
  } catch (err) {
    emit({ errors: [{ code: err.code ?? 'INVALID', message: err.message }] }, pretty, 2);
    return;
  }
  const first = house.schedule(payload.instructions ?? []);
  allErrors.push(...first.errors);
  if (payload.undo !== undefined) {
    if (!Array.isArray(payload.undo)) {
      allErrors.push({ code: 'INVALID', message: 'undo must be an array of {id, expectedVersion}' });
    } else {
      for (const entry of payload.undo) {
        const result = house.undo(entry?.id, entry?.expectedVersion);
        allErrors.push(...result.errors);
      }
    }
  }
  const report = house.report();
  report.errors = allErrors;
  emit(report, pretty, allErrors.length > 0 ? 2 : 0);
}

main();
