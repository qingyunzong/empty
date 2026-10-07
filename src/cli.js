#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const lineage = require('./lineage');

const { TraceError } = lineage;

const USAGE = `food-trace - offline batch lineage & recall tool

Usage:
  node src/cli.js build   --input events.jsonl --state state.json
  node src/cli.js correct --state state.json --inspection IN-1 --status fail [--reason TEXT]
  node src/cli.js recall  --state state.json [--out cert.json]
  node src/cli.js verify  (--state state.json | --input events.jsonl) --cert cert.json

Exit codes: 0 ok | 1 usage/io error | 2 certificate mismatch | 6 cycle | 7 dangling reference
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        throw new TraceError(`missing value for --${key}`, lineage.EXIT_ERROR);
      }
      args[key] = argv[i + 1];
      i += 1;
    } else {
      args._.push(token);
    }
  }
  return args;
}

function readFile(file, what) {
  if (!file) throw new TraceError(`missing ${what} path`, lineage.EXIT_ERROR);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new TraceError(`cannot read ${what} "${file}": ${err.message}`, lineage.EXIT_ERROR);
  }
}

function writeFile(file, text) {
  try {
    fs.writeFileSync(file, text);
  } catch (err) {
    throw new TraceError(`cannot write "${file}": ${err.message}`, lineage.EXIT_ERROR);
  }
}

function loadState(file) {
  let data;
  try {
    data = JSON.parse(readFile(file, 'state file'));
  } catch (err) {
    if (err instanceof TraceError) throw err;
    throw new TraceError(`state file is not valid JSON: ${err.message}`, lineage.EXIT_ERROR);
  }
  return lineage.deserializeState(data);
}

function saveState(file, state) {
  writeFile(file, JSON.stringify(lineage.serializeState(state), null, 2) + '\n');
}

function cmdBuild(args) {
  if (!args.input || !args.state) throw new TraceError('build requires --input and --state', lineage.EXIT_ERROR);
  const events = lineage.parseJsonl(readFile(args.input, 'input file'));
  const state = lineage.buildState(events);
  saveState(args.state, state);
  const edgeCount = [...state.batches.values()].reduce((n, b) => n + b.children.length, 0);
  console.log(JSON.stringify({
    ok: true,
    events: state.events.length,
    batches: state.batches.size,
    edges: edgeCount,
    contaminated: [...state.contaminated].sort(),
    input_hash: lineage.hashEvents(state.events),
  }, null, 2));
}

function cmdCorrect(args) {
  if (!args.state || !args.inspection || args.status === undefined) {
    throw new TraceError('correct requires --state, --inspection and --status', lineage.EXIT_ERROR);
  }
  const state = loadState(args.state);
  const delta = lineage.correctInspection(state, args.inspection, args.status, args.reason);
  saveState(args.state, state);
  console.log(JSON.stringify({ ok: true, ...delta }, null, 2));
}

function cmdRecall(args) {
  if (!args.state) throw new TraceError('recall requires --state', lineage.EXIT_ERROR);
  const state = loadState(args.state);
  const certificate = lineage.buildCertificate(state);
  const text = JSON.stringify(certificate, null, 2) + '\n';
  if (args.out) writeFile(args.out, text);
  process.stdout.write(text);
}

function cmdVerify(args) {
  if (!args.cert || (!args.state && !args.input)) {
    throw new TraceError('verify requires --cert and one of --state/--input', lineage.EXIT_ERROR);
  }
  const state = args.state
    ? loadState(args.state)
    : lineage.buildState(lineage.parseJsonl(readFile(args.input, 'input file')));
  let certificate;
  try {
    certificate = JSON.parse(readFile(args.cert, 'certificate file'));
  } catch (err) {
    if (err instanceof TraceError) throw err;
    throw new TraceError(`certificate is not valid JSON: ${err.message}`, lineage.EXIT_ERROR);
  }
  const result = lineage.verifyCertificate(state, certificate);
  if (result.ok) {
    console.log('OK: certificate replays and matches');
    return;
  }
  console.error(`MISMATCH: ${result.mismatches.join(', ')}`);
  process.exitCode = 2;
}

function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  switch (command) {
    case 'build': return cmdBuild(args);
    case 'correct': return cmdCorrect(args);
    case 'recall': return cmdRecall(args);
    case 'verify': return cmdVerify(args);
    default:
      process.stderr.write(USAGE);
      throw new TraceError(command ? `unknown command "${command}"` : 'missing command', lineage.EXIT_ERROR);
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof TraceError) {
      console.error(`error: ${err.message}`);
      process.exitCode = err.exitCode;
      return;
    }
    console.error(err.stack || String(err));
    process.exitCode = lineage.EXIT_ERROR;
  }
}

module.exports = { parseArgs, main };
