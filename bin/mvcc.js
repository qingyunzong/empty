#!/usr/bin/env node
import { runCli } from '../src/cli.js';

process.exitCode = runCli(process.argv.slice(2), {
  stdout: (chunk) => process.stdout.write(chunk),
  stderr: (chunk) => process.stderr.write(chunk),
});
