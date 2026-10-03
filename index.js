'use strict';

const { main } = require('./lib/cli');

process.exitCode = main(process.argv.slice(2));
