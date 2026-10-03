#!/usr/bin/env node
import { run } from './src/commands.js';

process.exitCode = run(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
