#!/usr/bin/env node
'use strict';
const { run } = require('../src/cli');

const { code, stdout, stderr } = run(process.argv.slice(2));
for (const line of stdout) process.stdout.write(JSON.stringify(line) + '\n');
for (const line of stderr) process.stderr.write(JSON.stringify(line) + '\n');
process.exit(code);
