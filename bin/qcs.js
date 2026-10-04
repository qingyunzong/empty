#!/usr/bin/env node
import fs from 'node:fs';
import { runCli } from '../src/cli.js';

const argv = process.argv.slice(2);
const needsStdin = (argv[0] === 'report' || argv[0] === 'correct')
  && !argv.includes('--json') && !argv.includes('--file');

let stdin = '';
if (needsStdin && !process.stdin.isTTY) {
  try {
    stdin = fs.readFileSync(0, 'utf8');
  } catch {
    stdin = '';
  }
}

const { code, stdout, stderr } = runCli(argv, {
  stdin,
  env: process.env,
});
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exit(code);
