'use strict';
const { main } = require('./lib/cli');

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
