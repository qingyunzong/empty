'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { computeHash, validateVersion, LineageError } = require('./version');

// Directory-backed store: one JSON file per version, named by lineage hash.
class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  pathFor(hash) {
    return path.join(this.dir, `${hash}.json`);
  }

  has(hash) {
    return typeof hash === 'string' && fs.existsSync(this.pathFor(hash));
  }

  get(hash) {
    if (!this.has(hash)) {
      throw new LineageError(`unknown version "${hash}"`, 'UNKNOWN_VERSION');
    }
    return JSON.parse(fs.readFileSync(this.pathFor(hash), 'utf8'));
  }

  // Validates, hashes and persists a version. Returns the lineage hash.
  put(version) {
    validateVersion(version, this);
    const hash = computeHash(version);
    const record = { ...version, parents: [...version.parents].sort(), hash };
    fs.writeFileSync(this.pathFor(hash), JSON.stringify(record, null, 2) + '\n');
    return hash;
  }

  list() {
    return fs.readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .sort();
  }
}

module.exports = { Store };
