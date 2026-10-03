#!/usr/bin/env node
import { writeSync } from 'node:fs';
import { run } from '../src/cli.js';

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    writeSync(2, `ERROR INTERNAL: ${err.message}\n`);
    process.exitCode = 1;
  }
);
