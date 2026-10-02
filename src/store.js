import { FormulaError } from './errors.js';
import { parseDimension, formatDim } from './dimensions.js';
import { parse } from './parser.js';
import { check } from './checker.js';
import { certificate } from './certificate.js';

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

export class FormulaStore {
  constructor(variables = {}) {
    this.env = {};
    for (const [name, dimName] of Object.entries(variables)) {
      this.env[name] = parseDimension(dimName);
    }
    this.versions = [];
    this.index = -1;
  }

  correct(source) {
    const ast = parse(source);       // throws on syntax/paren errors
    const dim = check(ast, this.env); // throws on dimensional errors
    deepFreeze(ast);
    const version = {
      version: this.index + 2,
      source,
      ast,
      dim,
      certificate: certificate(ast, this.env),
    };
    this.versions = this.versions.slice(0, this.index + 1);
    this.versions.push(version);
    this.index += 1;
    return this.#info(version);
  }

  undo() {
    if (this.index < 0) {
      throw new FormulaError('NOTHING_TO_UNDO', 'no version to undo to');
    }
    this.index -= 1;
    return this.current();
  }

  redo() {
    if (this.index >= this.versions.length - 1) {
      throw new FormulaError('NOTHING_TO_REDO', 'no version to redo');
    }
    this.index += 1;
    return this.current();
  }

  current() {
    if (this.index < 0) return null;
    return this.#info(this.versions[this.index]);
  }

  currentAst() {
    return this.index < 0 ? null : this.versions[this.index].ast;
  }

  #info(v) {
    return {
      version: v.version,
      formula: v.source,
      dimension: formatDim(v.dim),
      certificate: v.certificate,
    };
  }
}
