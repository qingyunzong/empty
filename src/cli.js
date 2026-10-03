'use strict';

const fs = require('fs');
const { Engine } = require('./engine');
const persist = require('./persist');
const { certificate } = require('./certificate');

const EXIT_ERROR = 9;

class CliError extends Error {}

function usage() {
  return [
    'usage: recon [--state DIR] [--rules v1|v2] [input.jsonl]',
    '',
    'Reads JSONL events from a file or stdin, emits difference clusters,',
    'suggestions and a certificate as JSONL on stdout.',
    '',
    'events:',
    '  {"type":"internal","id":"I1","amount":100.00,"ts":"2026-01-01T00:00:00Z"}',
    '  {"type":"external","id":"E1","amount":100.00,"ts":"2026-01-01T01:00:00Z"}',
    '  {"type":"revoke","id":"E1"}',
    '  {"type":"correct","id":"E1","amount":99.50,"side":"external"}',
    '  {"type":"rule","version":"v2"}',
    '  {"type":"emit"}   emit current difference clusters immediately',
    '',
  ].join('\n');
}

// io: { readStdin(): string, writeOut(s), writeErr(s) }
// Returns the process exit code.
function run(argv, io) {
  let stateDir = null;
  let rulesVersion = 'v1';
  let inputFile = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state') stateDir = argv[++i];
    else if (a === '--rules') rulesVersion = argv[++i];
    else if (a === '--help') {
      io.writeOut(usage());
      return 0;
    } else if (a.startsWith('--')) throw new CliError(`unknown option: ${a}`);
    else if (inputFile) throw new CliError(`unexpected argument: ${a}`);
    else inputFile = a;
  }
  if (stateDir === null && argv.includes('--state')) throw new CliError('--state needs a value');

  let engine = new Engine({ rulesVersion });
  if (stateDir) {
    const p = persist.paths(stateDir);
    if (fs.existsSync(p.journal) || fs.existsSync(p.snapshot) || fs.existsSync(p.manifest)) {
      engine = persist.recover(stateDir).engine;
    } else {
      fs.mkdirSync(stateDir, { recursive: true });
    }
  }

  let input;
  try {
    input = inputFile ? fs.readFileSync(inputFile, 'utf8') : io.readStdin();
  } catch (err) {
    throw new CliError(`cannot read input: ${err.message}`);
  }

  const emitClusters = () => {
    for (const c of engine.getDifferenceClusters()) {
      io.writeOut(JSON.stringify({ type: 'cluster', ...c }) + '\n');
    }
  };

  const lines = input.split('\n');
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new CliError(`line ${idx + 1}: invalid JSON`);
    }
    if (event && event.type === 'emit') {
      emitClusters();
      continue;
    }
    try {
      engine.apply(event);
    } catch (err) {
      throw new CliError(`line ${idx + 1}: ${err.message}`);
    }
    if (stateDir) persist.appendJournal(stateDir, engine.seq, event);
  }

  if (stateDir) persist.commit(stateDir, engine);

  emitClusters();
  for (const s of engine.getSuggestions()) {
    io.writeOut(JSON.stringify({ type: 'suggestion', ...s }) + '\n');
  }
  io.writeOut(JSON.stringify(certificate(engine)) + '\n');
  return 0;
}

function main(argv, io) {
  try {
    return run(argv, io);
  } catch (err) {
    io.writeErr(`recon: ${err && err.message ? err.message : String(err)}\n`);
    return EXIT_ERROR;
  }
}

module.exports = { run, main, usage, EXIT_ERROR };
