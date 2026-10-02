#!/usr/bin/env node
'use strict';

const { run, processIO } = require('../src/cli');

process.exit(run(process.argv.slice(2), processIO));
