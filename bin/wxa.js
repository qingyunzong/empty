#!/usr/bin/env node
import { runCli } from '../src/cli.js';

try {
  process.exit(runCli(process.argv.slice(2), process.env));
} catch (err) {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
}
