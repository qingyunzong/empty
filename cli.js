#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { runSample, verifyCertificate, loadState, saveState, AuditError } = require('./src/index');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file' || arg === '-f') {
      args.file = argv[++i];
    } else if (arg === '--state' || arg === '-s') {
      args.state = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function readJson(file) {
  const raw = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  return JSON.parse(raw);
}

function fail(err) {
  if (err instanceof AuditError) {
    process.stdout.write(JSON.stringify({ error: { code: err.code, message: err.message, details: err.details } }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ error: { code: 'INTERNAL', message: String(err && err.message || err), details: {} } }) + '\n');
  }
  process.exit(2);
}

const USAGE = [
  'Usage:',
  '  audit-sample sample [--state <path>] [--file <request.json>]',
  '  audit-sample verify [--file <certificate.json>]',
  '',
  'Reads JSON from --file or stdin, writes JSON to stdout.',
  'Exit code 2 on failure (error object printed to stdout).',
].join('\n');

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (args.help || !command) {
    process.stdout.write(USAGE + '\n');
    process.exit(command ? 0 : 2);
  }

  try {
    if (command === 'sample') {
      const request = readJson(args.file);
      const prior = loadState(args.state);
      const { output, state } = runSample(request, prior);
      saveState(args.state, state);
      process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    } else if (command === 'verify') {
      const certificate = readJson(args.file);
      const result = verifyCertificate(certificate);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      if (!result.valid) process.exit(2);
    } else {
      process.stdout.write(JSON.stringify({ error: { code: 'INVALID_INPUT', message: 'unknown command "' + command + '"', details: {} } }) + '\n');
      process.exit(2);
    }
  } catch (err) {
    fail(err);
  }
}

main();
