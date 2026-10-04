'use strict';

const { main } = require('./lib/cli');

process.exit(main(process.argv.slice(2)));
