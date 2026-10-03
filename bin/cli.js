#!/usr/bin/env node
import { runCliSafe } from '../src/cli-main.js';

const { code, stdout, stderr } = runCliSafe(process.argv.slice(2));
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exit(code);
