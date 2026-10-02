#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { run } = require('../src/cli');

const file = process.argv[2];
const input = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
const { lines, hadError } = run(input);
for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`);
process.exitCode = hadError ? 1 : 0;
