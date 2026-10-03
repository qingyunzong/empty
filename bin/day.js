#!/usr/bin/env node
'use strict';

const cli = require('../lib/cli');

process.exitCode = cli.run(process.argv.slice(2), {
  out: (msg) => console.log(msg),
  err: (msg) => console.error(msg),
});
