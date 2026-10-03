#!/usr/bin/env node
import { run } from '../src/cli.js';

try {
  process.exit(run(process.argv.slice(2)));
} catch (e) {
  process.stderr.write(`fatal: ${e.message}\n`);
  process.exit(1);
}
