#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {
  RejectError,
  initDir,
  applyPatch,
  recover,
} = require('./src/evidence');

const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_SIMULATED_CRASH = 2;

function usage() {
  console.error(
    [
      'usage:',
      '  node cli.js init <dir>',
      '  node cli.js apply <dir> <patch.json> [--fail-at=N]',
      '  node cli.js recover <dir>',
    ].join('\n')
  );
}

function parseFailAt(args) {
  for (const arg of args) {
    if (arg.startsWith('--fail-at=')) {
      const value = Number(arg.slice('--fail-at='.length));
      if (!Number.isInteger(value) || value < 1) {
        throw new RejectError(`invalid --fail-at value: ${arg}`);
      }
      return value;
    }
  }
  return undefined;
}

function main(argv) {
  const [command, dir, ...rest] = argv;
  switch (command) {
    case 'init': {
      if (!dir) throw new RejectError('init requires a directory');
      recover(dir);
      initDir(dir);
      console.log(`initialized ${dir}`);
      return EXIT_OK;
    }
    case 'apply': {
      const patchFile = rest.find((arg) => !arg.startsWith('--'));
      if (!dir || !patchFile) throw new RejectError('apply requires <dir> and <patch.json>');
      const failAt = parseFailAt(rest);
      const patch = JSON.parse(fs.readFileSync(patchFile, 'utf8'));
      const result = applyPatch(dir, patch, { failAt });
      if (result.crashed) {
        console.error(`simulated crash after op ${result.completed}`);
        return EXIT_SIMULATED_CRASH;
      }
      console.log(`committed ${result.completed} op(s)`);
      return EXIT_OK;
    }
    case 'recover': {
      if (!dir) throw new RejectError('recover requires a directory');
      const outcome = recover(dir);
      console.log(`recovery: ${outcome}`);
      return EXIT_OK;
    }
    default:
      usage();
      return EXIT_REJECTED;
  }
}

try {
  const code = main(process.argv.slice(2));
  if (code !== EXIT_OK) {
    process.exitCode = code;
  }
} catch (err) {
  if (err instanceof RejectError) {
    console.error(`rejected: ${err.message}`);
  } else {
    console.error(`error: ${err.message}`);
  }
  process.exitCode = EXIT_REJECTED;
}
