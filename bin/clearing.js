#!/usr/bin/env node
import { runCli } from '../src/cli.js';

process.exitCode = runCli(process.argv.slice(2), {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
});
