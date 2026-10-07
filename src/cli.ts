#!/usr/bin/env node
import { runCli } from './app.js';

const code = runCli(process.argv.slice(2), {
  out: (s) => console.log(s),
  err: (s) => process.stderr.write(s + '\n'),
});
process.exitCode = code;
