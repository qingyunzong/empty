#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { run, verify, MachineError } = require('./lib/machine');

function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  const events = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      throw new MachineError('E_PARSE', `${file}:${i + 1}: invalid JSON: ${err.message}`);
    }
  }
  return events;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new MachineError('E_PARSE', `${file}: invalid JSON: ${err.message}`);
  }
}

function cmdApply(args, out) {
  const [eventsFile, stateFile] = args;
  if (!eventsFile || !stateFile) {
    throw new MachineError('E_USAGE', 'usage: node cli.js apply <events.jsonl> <state.json>');
  }
  const events = readJsonl(eventsFile);
  const result = run(events);
  const bundle = {
    version: 1,
    head: result.head,
    state: result.state,
    certs: result.certs,
    events: result.events,
  };
  fs.writeFileSync(stateFile, JSON.stringify(bundle, null, 2) + '\n');
  for (const cert of result.certs) {
    out({ type: 'cert', ...cert });
  }
  out({
    type: 'final',
    balance: result.state.balance,
    revocable: result.state.revocable,
    head: result.head,
  });
}

function cmdVerify(args, out) {
  const [stateFile] = args;
  if (!stateFile) {
    throw new MachineError('E_USAGE', 'usage: node cli.js verify <state.json>');
  }
  const bundle = readJson(stateFile);
  const result = verify(bundle);
  out({ type: 'verify', ok: true, steps: result.steps, head: result.head });
}

// Returns process exit code. io: { stdout(lineObj), stderr(text) }.
function main(argv, io) {
  const stdout = io && io.stdout ? io.stdout : (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const stderr = io && io.stderr ? io.stderr : (text) => process.stderr.write(text + '\n');
  try {
    const [cmd, ...args] = argv;
    switch (cmd) {
      case 'apply':
        cmdApply(args, stdout);
        return 0;
      case 'verify':
        cmdVerify(args, stdout);
        return 0;
      default:
        throw new MachineError(
          'E_USAGE',
          'usage: node cli.js apply <events.jsonl> <state.json> | node cli.js verify <state.json>'
        );
    }
  } catch (err) {
    const code = err instanceof MachineError && err.code ? err.code : 'E_UNKNOWN';
    stderr(`${code}: ${err.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main };
