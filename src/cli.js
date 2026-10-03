#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { InputError, loadInstanceFile } = require('./model');
const { solve } = require('./solver');

class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliError';
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'schedule') {
    throw new CliError('usage: node src/cli.js schedule <input.json> [--budget N]');
  }
  let inputPath = null;
  let budget;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--budget') {
      const value = rest[++i];
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new CliError('--budget requires a non-negative integer');
      }
      budget = Number(value);
    } else if (arg.startsWith('--')) {
      throw new CliError(`unknown option: ${arg}`);
    } else if (inputPath === null) {
      inputPath = arg;
    } else {
      throw new CliError(`unexpected argument: ${arg}`);
    }
  }
  if (inputPath === null) throw new CliError('missing input file');
  return { inputPath, budget };
}

// Runs the CLI logic in-process; returns { code, stdout, stderr }.
function runCli(argv) {
  try {
    const { inputPath, budget } = parseArgs(argv);
    const instance = loadInstanceFile(fs, inputPath);
    const result = solve(instance, budget === undefined ? {} : { budget });
    return { code: 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: '' };
  } catch (err) {
    if (err instanceof CliError || err instanceof InputError) {
      return { code: 2, stdout: '', stderr: `error: ${err.message}\n` };
    }
    throw err;
  }
}

if (require.main === module) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}

module.exports = { runCli };
