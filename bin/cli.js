#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { runCli } = require('../src/cli');

const res = runCli(process.argv.slice(2), () => fs.readFileSync(0, 'utf8'));
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);
process.exit(res.code);
