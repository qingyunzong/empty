#!/usr/bin/env node
'use strict';

const { readFileSync } = require('node:fs');
const { runCli } = require('./src/cliApp');

const code = runCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  readStdin: () => readFileSync(0, 'utf8'),
});
process.exit(code);
