#!/usr/bin/env node
'use strict';

const { runCli } = require('./lib/cli');

process.exitCode = runCli(process.argv.slice(2));
