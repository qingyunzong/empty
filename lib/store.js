'use strict';

const crypto = require('node:crypto');
const { parse, canonicalString, FormulaError } = require('./formula');

class UnknownNameError extends FormulaError {
  constructor(message) { super(`unknown name: ${message}`); this.name = 'UnknownNameError'; }
}
class StateError extends FormulaError {
  constructor(message) { super(`state error: ${message}`); this.name = 'StateError'; }
}

class FormulaStore {
  constructor() {
    this.formulas = new Map();
  }

  def(name, source) {
    if (this.formulas.has(name)) {
      throw new StateError(`'${name}' is already defined`);
    }
    const ast = parse(source);
    this.formulas.set(name, { name, versions: [ast], index: 0 });
    return { name, version: 1 };
  }

  correct(name, source) {
    const entry = this.#lookup(name);
    const ast = parse(source);
    entry.versions = entry.versions.slice(0, entry.index + 1);
    entry.versions.push(ast);
    entry.index += 1;
    return { name, version: entry.index + 1 };
  }

  undo(name) {
    const entry = this.#lookup(name);
    if (entry.index === 0) {
      throw new StateError(`'${name}' has no earlier version to undo to`);
    }
    entry.index -= 1;
    return { name, version: entry.index + 1 };
  }

  redo(name) {
    const entry = this.#lookup(name);
    if (entry.index >= entry.versions.length - 1) {
      throw new StateError(`'${name}' has nothing to redo`);
    }
    entry.index += 1;
    return { name, version: entry.index + 1 };
  }

  certify(name) {
    const entry = this.#lookup(name);
    const version = entry.index + 1;
    const payload = JSON.stringify({
      ast: JSON.parse(canonicalString(entry.versions[entry.index])),
      name,
      version,
    });
    const sha256 = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
    return { name, version, sha256 };
  }

  currentVersion(name) {
    return this.#lookup(name).index + 1;
  }

  #lookup(name) {
    const entry = this.formulas.get(name);
    if (!entry) throw new UnknownNameError(`'${name}' is not defined`);
    return entry;
  }
}

module.exports = { FormulaStore, UnknownNameError, StateError };
