#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { main } = require('../src/cli');

const code = main(process.argv.slice(2), {
  readStdin: () => fs.readFileSync(0, 'utf8'),
  writeOut: (s) => process.stdout.write(s),
  writeErr: (s) => process.stderr.write(s),
});
process.exit(code);
