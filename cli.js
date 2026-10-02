#!/usr/bin/env node
// Usage: node cli.js trades.json rates.json
// Reads trades + versioned FX rates, runs netting, writes the result JSON to
// stdout. Domain errors are also reported as JSON on stdout with exit code 1.
import { runCli } from './src/cliMain.js';

const { status, stdout, stderr } = runCli(process.argv.slice(2));
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exit(status);
