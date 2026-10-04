#!/usr/bin/env node
'use strict';

const { main } = require('./src/cli');

// Use exitCode (not process.exit) so piped stdout/stderr are flushed.
process.exitCode = main(process.argv.slice(2));
