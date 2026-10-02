#!/usr/bin/env node
'use strict';

const { runCli } = require('../src/cli');

process.exitCode = runCli(process.argv.slice(2));
