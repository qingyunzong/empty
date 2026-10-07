#!/usr/bin/env node
'use strict';

const { TimezoneTable } = require('./timezone');
const { Calendar } = require('./calendar');
const { Engine } = require('./engine');
const { CalendarError } = require('./intervals');

// Input (JSON on stdin, or a file path as argv[2]):
//   {
//     "timezones": { "Zone/Name": [{ "from": 0, "offsetMinutes": 480 }] },
//     "calendar":  { "shifts": [...], "exceptions": [...], "handovers": [...] },
//     "ops": [
//       { "op": "begin", "tx": "t1" },
//       { "op": "command", "command": { "id": "c1", "kind": "occupy",
//           "resource": "dev-A", "start": 0, "end": 1000, "baseVersion": 0 } },
//       { "op": "savepoint", "name": "sp1" },
//       { "op": "rollbackTo", "name": "sp1" },
//       { "op": "commit" },
//       { "op": "expand", "shift": {...}, "window": { "start": 0, "end": 1 } },
//       { "op": "busy", "window": { "start": 0, "end": 1 } }
//     ]
//   }
// Output: JSON array with one result per op.
function run(input) {
  const tzTable = new TimezoneTable(input.timezones ?? { UTC: [{ from: 0, offsetMinutes: 0 }] });
  const calendar = new Calendar(tzTable, input.calendar ?? {});
  const engine = new Engine();

  const results = [];
  for (const op of input.ops ?? []) {
    if (op.op === 'expand') {
      results.push(wrap(() => ({
        ok: true,
        intervals: calendar.expandShift(op.shift, op.window.start, op.window.end),
      })));
    } else if (op.op === 'busy') {
      results.push(wrap(() => ({
        ok: true,
        intervals: calendar.busyIntervals(op.window.start, op.window.end),
      })));
    } else {
      results.push(engine.process(op));
    }
  }
  return { version: engine.version, results };
}

function wrap(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof CalendarError) {
      return { ok: false, error: { code: err.code, message: err.message, details: err.details ?? null } };
    }
    throw err;
  }
}

function main() {
  const fs = require('fs');
  const arg = process.argv[2];
  if (arg && arg !== '-') {
    const input = JSON.parse(fs.readFileSync(arg, 'utf8'));
    process.stdout.write(JSON.stringify(run(input), null, 2) + '\n');
    return;
  }
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    process.stdout.write(JSON.stringify(run(input), null, 2) + '\n');
  });
}

if (require.main === module) main();

module.exports = { run };
