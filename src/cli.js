// CLI implementation, importable for in-process testing.
// runCli(argv, io) -> exit code. io: { stdout(text), stderr(text) }.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ClearingError } from './errors.js';
import { loadTzTable } from './tztable.js';
import { loadCalendar } from './calendar.js';
import { createState, applyFlows } from './settle.js';
import { hashInputs, buildReport, replay, verifyReport } from './certificate.js';

const USAGE = `Usage:
  clearing settle --tzdb F --calendars F --flows F [--state-in F] [--state-out F] [--out F]
  clearing verify --tzdb F --calendars F --flows F --report F

Commands:
  settle   Apply an append-only flow batch; print/write the daily net report.
  verify   Replay the full flow history and check a stored report's certificate.

Exit codes: 0 ok, 1 unexpected, 2 E_INPUT, 3 E_TZ_UNKNOWN, 4 E_GAP, 5 E_OVERLAP, 6 E_ORDER`;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ClearingError('E_INPUT', `cannot read/parse ${path}: ${e.message}`);
  }
}

function loadInputs(values) {
  const tzdbRaw = readJson(values.tzdb);
  const calendarsRaw = readJson(values.calendars);
  const flows = readJson(values.flows);
  const tzTable = loadTzTable(tzdbRaw);
  if (!Array.isArray(calendarsRaw)) throw new ClearingError('E_INPUT', 'calendars file must be a JSON array');
  const calendars = new Map(calendarsRaw.map((c) => {
    const cal = loadCalendar(c);
    return [cal.id, cal];
  }));
  const inputHashes = hashInputs({ tzdbRaw, calendarsRaw });
  return { tzTable, calendars, flows, inputHashes };
}

function cmdSettle(values, io) {
  const { tzTable, calendars, flows, inputHashes } = loadInputs(values);
  const state = values['state-in'] ? readJson(values['state-in']) : createState();
  const { affectedDays, pending } = applyFlows({ tzTable, calendars, flows, state });
  const report = buildReport({ tzTable, calendars, state, inputHashes, affectedDays });
  const text = JSON.stringify(report, null, 2) + '\n';
  if (values.out) writeFileSync(values.out, text);
  else io.stdout(text);
  if (values['state-out']) writeFileSync(values['state-out'], JSON.stringify(state, null, 2) + '\n');
  const summary = {
    applied: flows.length,
    affectedDays: affectedDays.length,
    pending: pending.length,
    inputHash: report.certificate.inputHash,
    resultsHash: report.certificate.resultsHash,
  };
  io.stderr(`settle ok: ${JSON.stringify(summary)}\n`);
  return 0;
}

function cmdVerify(values, io) {
  if (!values.report) throw new ClearingError('E_INPUT', 'verify requires --report');
  const { tzTable, calendars, flows, inputHashes } = loadInputs(values);
  const stored = readJson(values.report);
  const replayed = replay({ tzTable, calendars, flows, inputHashes });
  const mismatches = verifyReport(stored, replayed);
  if (mismatches.length > 0) {
    io.stderr(`verify FAILED: ${mismatches.join(', ')}\n`);
    return 1;
  }
  io.stderr(`verify ok: inputHash=${stored.certificate.inputHash} resultsHash=${stored.certificate.resultsHash}\n`);
  return 0;
}

export function runCli(argv, io) {
  try {
    const [command, ...rest] = argv;
    if (command !== 'settle' && command !== 'verify') {
      io.stderr(USAGE + '\n');
      return command === undefined || command === 'help' || command === '--help' ? 0 : 2;
    }
    const { values } = parseArgs({
      args: rest,
      options: {
        tzdb: { type: 'string' },
        calendars: { type: 'string' },
        flows: { type: 'string' },
        'state-in': { type: 'string' },
        'state-out': { type: 'string' },
        out: { type: 'string' },
        report: { type: 'string' },
      },
      strict: true,
    });
    for (const required of ['tzdb', 'calendars', 'flows']) {
      if (!values[required]) throw new ClearingError('E_INPUT', `missing required --${required}`);
    }
    return command === 'settle' ? cmdSettle(values, io) : cmdVerify(values, io);
  } catch (e) {
    if (e instanceof ClearingError) {
      io.stderr(`ERROR ${e.code}: ${e.message}\n`);
      if (e.details !== undefined) io.stderr(`details: ${JSON.stringify(e.details)}\n`);
      return e.exitCode;
    }
    io.stderr(`ERROR unexpected: ${e.stack ?? e.message}\n`);
    return 1;
  }
}
