#!/usr/bin/env node
'use strict';

const { run } = require('./src/cli');

process.exit(run(process.argv.slice(2)));
