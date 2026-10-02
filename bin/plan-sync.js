#!/usr/bin/env node
import fs from 'node:fs';
import { main } from '../src/cli.js';

try {
  main(process.argv.slice(2));
} catch (e) {
  fs.writeSync(2, JSON.stringify({ error: { code: 1, type: 'internal', message: String((e && e.message) || e) } }) + '\n');
  process.exit(1);
}
