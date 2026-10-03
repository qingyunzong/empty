#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const lib = require('./src/lib.js');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function readJsonl(path) {
  if (!fs.existsSync(path)) return [];
  return fs.readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function writeJsonl(path, records) {
  fs.writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function loadInputs(args) {
  return {
    lots: readJson(args.lots).lots,
    testEvents: readJsonl(args.tests),
    policy: readJson(args.policy),
  };
}

// Returns the process exit code; output goes through the injected io streams.
function run(argv, io) {
  const args = parseArgs(argv);
  const command = args._[0];
  try {
    if (command === 'evaluate') {
      const inputs = loadInputs(args);
      const existingCerts = readJsonl(args.cert);
      const result = lib.evaluate({ ...inputs, existingCerts });
      writeJsonl(args.cert, result.certs);
      io.stdout(JSON.stringify({ appended: result.appended.length }) + '\n');
      return 0;
    }
    if (command === 'verify') {
      const inputs = loadInputs(args);
      const certs = readJsonl(args.cert);
      lib.verify({ ...inputs, certs });
      io.stdout(JSON.stringify({ verified: certs.length }) + '\n');
      return 0;
    }
    io.stderr('usage: cli.js <evaluate|verify> --lots lots.json --tests tests.jsonl --policy policy.json --cert cert.jsonl\n');
    return 2;
  } catch (err) {
    if (err instanceof lib.QaError) {
      io.stderr(`error[${err.code}]: ${err.message}\n`);
      return lib.EXIT_CODES[err.code] || 1;
    }
    throw err;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
}

module.exports = { run };
