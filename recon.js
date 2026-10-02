#!/usr/bin/env node
'use strict';
const { run } = require('./src/cli');
// Use exitCode (not process.exit) so piped stderr/stdout are flushed.
process.exitCode = run(process.argv.slice(2));
