#!/usr/bin/env node
'use strict';

const { runCli } = require('./src/cli-core');

process.exitCode = runCli(process.argv.slice(2));
