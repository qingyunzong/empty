#!/usr/bin/env node
import { main } from './src/app.js';
import { SimulatedCrash } from './src/errors.js';

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (err instanceof SimulatedCrash) process.exit(97);
  throw err;
}
