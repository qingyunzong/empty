#!/usr/bin/env node
'use strict';

const { readFileSync } = require('node:fs');
const { run } = require('../src/cli');

const code = run(process.argv, {
  readStdin: () => readFileSync(0, 'utf8'),
  readFile: (path) => readFileSync(path, 'utf8'),
  write: (s) => process.stdout.write(s),
});
process.exit(code);
