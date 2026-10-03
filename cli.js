#!/usr/bin/env node
'use strict';

const { run } = require('./lib/runner');

process.stdin.setEncoding('utf8');

run(process.argv.slice(2), { stdin: process.stdin })
  .then(({ code, stdout, stderr }) => {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.exit(code);
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
