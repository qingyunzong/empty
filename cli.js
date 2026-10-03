#!/usr/bin/env node
// Usage: node cli.js <command.json | -> <logDir>
// Prints the JSON result on stdout. On error prints
// {"error":{"code":...,"message":...}} and exits with code 1.
import { run } from './src/cli.js';

run(process.argv.slice(2));
