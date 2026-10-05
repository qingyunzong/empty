#!/usr/bin/env node
import { runCli } from '../src/cli.js';

process.exit(runCli(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
}));
