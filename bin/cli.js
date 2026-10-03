#!/usr/bin/env node
import { runCli } from '../src/cli.js';

const code = runCli(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});
process.exit(code);
