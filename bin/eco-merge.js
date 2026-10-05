#!/usr/bin/env node
import { run } from '../src/cli.js';

const { code, out, err } = run(process.argv.slice(2));
if (out) process.stdout.write(out);
if (err) process.stderr.write(err);
process.exit(code);
