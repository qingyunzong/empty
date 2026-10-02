#!/usr/bin/env node
import { main } from '../src/cli.js';

try {
  process.exit(main(process.argv.slice(2)));
} catch (e) {
  console.error(e);
  process.exit(1);
}
