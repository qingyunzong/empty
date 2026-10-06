#!/usr/bin/env node
// CLI: reads NDJSON records from stdin, writes NDJSON results to stdout.
// Every valid record is persisted with appendFileSync BEFORE it is processed.
//
//   node src/cli.js --state state.log [--crashAfter N] [--recover]
//
// Exit codes: 0 ok, 2 error (MALFORMED | UNKNOWN_RETRACT | DURABLE_STATE_CORRUPT),
// 101 simulated crash (--crashAfter).
import fs from 'node:fs';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { Joiner, JoinError, validateRecord } from './index.js';

function fail(code, message) {
  process.stderr.write(JSON.stringify({ error: code, message }) + '\n');
  process.exit(2);
}

function parseCliArgs(argv) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        state: { type: 'string' },
        crashAfter: { type: 'string' },
        recover: { type: 'boolean', default: false },
      },
      strict: true,
    });
  } catch (err) {
    fail('MALFORMED', `invalid arguments: ${err.message}`);
  }
  if (!args.values.state) fail('MALFORMED', 'missing required --state <path>');
  let crashAfter = null;
  if (args.values.crashAfter !== undefined) {
    crashAfter = Number(args.values.crashAfter);
    if (!Number.isInteger(crashAfter) || crashAfter < 1) {
      fail('MALFORMED', '--crashAfter must be a positive integer');
    }
  }
  return { statePath: args.values.state, crashAfter, recover: args.values.recover };
}

// Read and strictly validate the durable state log.
// Returns { committed: [{seq, record}], pending: {seq, record} | null }.
function readStateLog(statePath) {
  if (!fs.existsSync(statePath)) {
    fail('DURABLE_STATE_CORRUPT', `state log not found: ${statePath}`);
  }
  let text;
  try {
    text = fs.readFileSync(statePath, 'utf8');
  } catch (err) {
    fail('DURABLE_STATE_CORRUPT', `cannot read state log: ${err.message}`);
  }
  const lines = text.split('\n').filter((line) => line.length > 0);
  const committed = [];
  let pending = null;
  let expectedSeq = 1;
  for (let i = 0; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      fail('DURABLE_STATE_CORRUPT', `state log line ${i + 1} is not valid JSON`);
    }
    if (entry === null || typeof entry !== 'object') {
      fail('DURABLE_STATE_CORRUPT', `state log line ${i + 1} is not an object`);
    }
    if (entry.kind === 'record') {
      if (pending !== null) {
        fail('DURABLE_STATE_CORRUPT', `record seq ${pending.seq} has no committed results`);
      }
      if (entry.seq !== expectedSeq) {
        fail('DURABLE_STATE_CORRUPT', `expected record seq ${expectedSeq}, found ${entry.seq}`);
      }
      try {
        validateRecord(entry.record);
      } catch (err) {
        fail('DURABLE_STATE_CORRUPT', `state log record seq ${entry.seq} is invalid: ${err.message}`);
      }
      pending = { seq: entry.seq, record: entry.record };
      expectedSeq += 1;
    } else if (entry.kind === 'results') {
      if (pending === null || entry.seq !== pending.seq) {
        fail('DURABLE_STATE_CORRUPT', `results entry seq ${entry.seq} has no matching record`);
      }
      if (!Array.isArray(entry.results)) {
        fail('DURABLE_STATE_CORRUPT', `results entry seq ${entry.seq} is not an array`);
      }
      committed.push(pending);
      pending = null;
    } else {
      fail('DURABLE_STATE_CORRUPT', `state log line ${i + 1} has unknown kind ${String(entry.kind)}`);
    }
  }
  return { committed, pending };
}

function appendLine(statePath, entry) {
  fs.appendFileSync(statePath, JSON.stringify(entry) + '\n');
}

function emit(outputs) {
  for (const output of outputs) {
    process.stdout.write(JSON.stringify(output) + '\n');
  }
}

async function main() {
  const { statePath, crashAfter, recover } = parseCliArgs(process.argv.slice(2));
  const joiner = new Joiner();
  let seq = 0;
  let skipFromStdin = 0;

  if (recover) {
    const { committed, pending } = readStateLog(statePath);
    // Re-apply committed records without re-emitting: their results were
    // already committed to stdout before the crash and must not be duplicated.
    for (const { record } of committed) {
      joiner.process(record);
      seq += 1;
    }
    // The crashed record was persisted but never processed: process it now,
    // commit its results to the log, and emit them.
    if (pending !== null) {
      const outputs = joiner.process(pending.record);
      appendLine(statePath, { kind: 'results', seq: pending.seq, results: outputs });
      emit(outputs);
      seq += 1;
    }
    skipFromStdin = seq; // these records are already in the log
  } else {
    fs.writeFileSync(statePath, ''); // fresh run starts a fresh log
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let lineNo = 0;
  let stdinSeq = 0;
  for await (const line of rl) {
    lineNo += 1;
    if (line.trim().length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      fail('MALFORMED', `input line ${lineNo} is not valid JSON`);
    }
    try {
      validateRecord(record);
    } catch (err) {
      fail(err.code, `input line ${lineNo}: ${err.message}`);
    }
    stdinSeq += 1;
    if (stdinSeq <= skipFromStdin) continue; // already persisted and handled from the log
    seq += 1;
    appendLine(statePath, { kind: 'record', seq, record });
    if (crashAfter !== null && seq === crashAfter) {
      // Persisted, but results not yet produced: simulate the crash.
      process.exit(101);
    }
    let outputs;
    try {
      outputs = joiner.process(record);
    } catch (err) {
      if (err instanceof JoinError) fail(err.code, err.message);
      throw err;
    }
    appendLine(statePath, { kind: 'results', seq, results: outputs });
    emit(outputs);
  }
}

main().catch((err) => {
  if (err instanceof JoinError) fail(err.code, err.message);
  process.stderr.write(JSON.stringify({ error: 'INTERNAL', message: String(err && err.message) }) + '\n');
  process.exit(2);
});
