#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { buildSnapshot, verifySnapshot, MachineError } = require('./lib/machine');

class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

function readJsonLines(path) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new CliError('E_IO', 'cannot read ' + path + ': ' + err.message);
  }
  const events = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      throw new CliError('E_BAD_EVENT', path + ':' + (i + 1) + ': invalid JSON: ' + err.message);
    }
  }
  return events;
}

function cmdApply(eventsPath, statePath, io) {
  const events = readJsonLines(eventsPath);
  let snapshot;
  try {
    snapshot = buildSnapshot(events);
  } catch (err) {
    if (err instanceof MachineError) throw new CliError(err.code, err.message);
    throw err;
  }
  try {
    fs.writeFileSync(statePath, JSON.stringify(snapshot, null, 2) + '\n');
  } catch (err) {
    throw new CliError('E_IO', 'cannot write ' + statePath + ': ' + err.message);
  }
  for (const cert of snapshot.certs) {
    io.stdout(JSON.stringify(cert) + '\n');
  }
}

function cmdVerify(statePath, io) {
  let text;
  try {
    text = fs.readFileSync(statePath, 'utf8');
  } catch (err) {
    throw new CliError('E_IO', 'cannot read ' + statePath + ': ' + err.message);
  }
  let snapshot;
  try {
    snapshot = JSON.parse(text);
  } catch (err) {
    throw new CliError('E_CERT', 'state file is not valid JSON: ' + err.message);
  }
  let result;
  try {
    result = verifySnapshot(snapshot);
  } catch (err) {
    if (err instanceof MachineError) throw new CliError(err.code, err.message);
    throw err;
  }
  io.stdout(JSON.stringify(result) + '\n');
}

const USAGE =
  'usage:\n' +
  '  node cli.js apply <events.jsonl> <state.json>\n' +
  '  node cli.js verify <state.json>\n';

// Returns the process exit code; all output goes through io.
function run(argv, io) {
  const [cmd, ...args] = argv;
  try {
    if (cmd === 'apply' && args.length === 2) {
      cmdApply(args[0], args[1], io);
    } else if (cmd === 'verify' && args.length === 1) {
      cmdVerify(args[0], io);
    } else {
      io.stderr(USAGE);
      return 1;
    }
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr(err.code + ': ' + err.message + '\n');
      return 1;
    }
    throw err;
  }
}

if (require.main === module) {
  const code = run(process.argv.slice(2), {
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
  });
  process.exitCode = code;
}

module.exports = { run, CliError, USAGE };
