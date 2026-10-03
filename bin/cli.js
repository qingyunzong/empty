#!/usr/bin/env node
'use strict';

const { run } = require('../src/cli');

const { code, output } = run(process.argv.slice(2));
const stream = code === 2 ? process.stderr : process.stdout;
stream.write(output + '\n');
process.exitCode = code;
