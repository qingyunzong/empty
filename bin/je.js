#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli');
const { JeError } = require('../src/errors');

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof JeError) {
    process.stderr.write(`${err.code}: ${err.message}\n`);
    process.exit(err.code === 'E_USAGE' ? 2 : 1);
  }
  throw err;
}
