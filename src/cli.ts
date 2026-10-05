#!/usr/bin/env node
import { runCli } from './app.js';

const res = runCli(process.argv.slice(2));
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);
process.exit(res.code);
