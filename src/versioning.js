'use strict';

const crypto = require('node:crypto');
const units = require('./units');
const { parseFormula } = require('./parser');
const { check, enumerateDimensions } = require('./checker');
const { FormulaError } = require('./errors');

// Structural, position-free canonical form of an AST (keys sorted).
function normalizeAst(node) {
  switch (node.type) {
    case 'Number':
      return { type: 'Number', value: node.value };
    case 'Var':
      return { name: node.name, type: 'Var' };
    case 'Unary':
      return { arg: normalizeAst(node.arg), op: node.op, type: 'Unary' };
    case 'Binary':
      return {
        left: normalizeAst(node.left),
        op: node.op,
        right: normalizeAst(node.right),
        type: 'Binary',
      };
    case 'Call':
      return { args: node.args.map(normalizeAst), name: node.name, type: 'Call' };
    case 'Assign':
      return { target: node.target, type: 'Assign', value: normalizeAst(node.value) };
    default:
      throw new FormulaError('INTERNAL', `cannot normalize node type "${node.type}"`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// SHA-256 over the normalized AST plus the dimension table.
function certificateOf(ast, table) {
  const dims = {};
  for (const [name, vec] of [...table.entries()].sort()) {
    dims[name] = units.formatDimension(vec);
  }
  const canonical = canonicalize({ ast: normalizeAst(ast), dimensions: dims });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function summarize(version, index) {
  if (!version) return null;
  return {
    version: index + 1,
    formula: version.formula,
    dimension: units.formatDimension(version.dim),
    certificate: version.certificate,
  };
}

class FormulaStore {
  constructor(variables = {}) {
    this.baseEnv = new Map();
    for (const [name, dimName] of Object.entries(variables)) {
      this.baseEnv.set(name, units.parseDimension(dimName));
    }
    this.versions = []; // immutable version records
    this.index = -1;
  }

  // Parse + statically check the formula; only on success append a new
  // immutable version (dropping any redo branch). On error the current
  // version is left untouched.
  correct(formula) {
    const ast = parseFormula(formula); // throws on paren/syntax errors
    const { dim, table } = check(ast, this.baseEnv); // throws on dim/variable errors
    const version = Object.freeze({
      formula,
      ast,
      dim,
      table: new Map(table),
      certificate: certificateOf(ast, table),
    });
    this.versions = this.versions.slice(0, this.index + 1);
    this.versions.push(version);
    this.index = this.versions.length - 1;
    // Assigned variables (e.g. `v` in `v=a/t`) become available to later versions.
    this.baseEnv = new Map(table);
    return summarize(version, this.index);
  }

  undo() {
    if (this.index <= 0 && this.versions.length === 0) {
      throw new FormulaError('NO_VERSION', 'nothing to undo: no versions exist');
    }
    if (this.index < 0) throw new FormulaError('NO_VERSION', 'nothing to undo');
    this.index -= 1;
    return summarize(this.versions[this.index], this.index);
  }

  redo() {
    if (this.index + 1 >= this.versions.length) {
      throw new FormulaError('NO_VERSION', 'nothing to redo');
    }
    this.index += 1;
    return summarize(this.versions[this.index], this.index);
  }

  current() {
    return summarize(this.versions[this.index], this.index);
  }

  enumerate() {
    const v = this.versions[this.index];
    if (!v) throw new FormulaError('NO_VERSION', 'no current version');
    return enumerateDimensions(v.ast, v.formula);
  }
}

module.exports = { FormulaStore, normalizeAst, certificateOf, canonicalize };
