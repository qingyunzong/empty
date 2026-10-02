#!/usr/bin/env node
import { main } from '../src/cli.js';

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(err.stack ?? String(err));
  process.exitCode = 1;
}
