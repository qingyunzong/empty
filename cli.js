#!/usr/bin/env node
import { runCli } from './src/cli.js';

const { status, stdout, stderr } = runCli(process.argv.slice(2));
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exitCode = status;
