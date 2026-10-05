'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wip-count-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { tmpDir, cleanup };
