'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'budget-test-'));
}

module.exports = { tmpdir };
