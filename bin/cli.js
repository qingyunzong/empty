#!/usr/bin/env node
'use strict';

const { runCli } = require('../src/cli.js');

const { code, stdout, stderr } = runCli(process.argv.slice(2));
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exitCode = code;
