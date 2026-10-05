#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const { Joiner, JoinError, validateRecord } = require('./joiner');
const { StateLog, replayLog } = require('./state-log');

function writeOut(record) {
  fs.writeSync(1, JSON.stringify(record) + '\n');
}

function fail(error) {
  const payload = { error: error.code || 'INTERNAL', message: error.message };
  if (error.details !== undefined) payload.details = error.details;
  fs.writeSync(2, JSON.stringify(payload) + '\n');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { state: null, recover: false, crashAfter: null, input: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--state') {
      args.state = argv[++i];
    } else if (arg === '--input') {
      args.input = argv[++i];
    } else if (arg === '--recover') {
      args.recover = true;
    } else if (arg === '--crashAfter') {
      args.crashAfter = Number(argv[++i]);
      if (!Number.isInteger(args.crashAfter) || args.crashAfter < 1) {
        throw new JoinError('MALFORMED', '--crashAfter must be a positive integer');
      }
    } else {
      throw new JoinError('MALFORMED', `unknown argument: ${arg}`);
    }
  }
  if (!args.state) throw new JoinError('MALFORMED', '--state <path> is required');
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(err);
  }

  const joiner = new Joiner();
  let log;
  const recoveredIns = [];
  if (args.recover) {
    if (!fs.existsSync(args.state)) {
      fail(new JoinError('DURABLE_STATE_CORRUPT', `state log not found: ${args.state}`));
    }
    try {
      const opened = StateLog.openExisting(args.state);
      log = opened.log;
      replayLog(opened.entries, log, joiner, writeOut);
      for (const entry of opened.entries) {
        if (entry.kind === 'in') recoveredIns.push(entry.record);
      }
    } catch (err) {
      fail(err);
    }
  } else {
    log = StateLog.fresh(args.state);
  }

  let inputStream = process.stdin;
  if (args.input) {
    try {
      inputStream = fs.createReadStream(args.input);
    } catch (err) {
      fail(new JoinError('MALFORMED', `cannot open input: ${err.message}`));
    }
  }
  const rl = readline.createInterface({ input: inputStream, terminal: false });
  let validCount = 0;
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber += 1;
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(new JoinError('MALFORMED', `line ${lineNumber} is not valid JSON`, { line: lineNumber }));
    }
    let record;
    try {
      record = validateRecord(parsed);
    } catch (err) {
      err.details = { ...(err.details || {}), line: lineNumber };
      fail(err);
    }
    // Records already persisted in the recovered log are skipped so that
    // replaying the same input never duplicates committed results.
    if (recoveredIns.length > 0) {
      const expected = recoveredIns.shift();
      if (JSON.stringify(expected) !== JSON.stringify(record)) {
        fail(new JoinError(
          'DURABLE_STATE_CORRUPT',
          `input record at line ${lineNumber} does not match recovered state log`,
          { line: lineNumber }
        ));
      }
      continue;
    }
    // Persist every valid record before processing it.
    log.append('in', record);
    validCount += 1;
    if (args.crashAfter === validCount) {
      process.exit(101);
    }
    let outputs;
    try {
      outputs = joiner.process(record);
    } catch (err) {
      fail(err);
    }
    for (const output of outputs) {
      log.append('out', output);
      writeOut(output);
    }
    log.append('commit');
  }
}

main().catch((err) => {
  if (err instanceof JoinError) {
    fail(err);
  }
  fs.writeSync(2, JSON.stringify({ error: 'INTERNAL', message: String(err && err.message) }) + '\n');
  process.exit(2);
});
