'use strict';

const crypto = require('crypto');
const { parse } = require('./parser');
const { normalize, canonical } = require('./normalize');
const { typecheck, validateSchema } = require('./typecheck');
const { compile } = require('./compiler');
const { execute } = require('./vm');

const DEFAULT_BUDGET = 10000;

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

class EvidenceEngine {
  constructor({ schema, records, budget = DEFAULT_BUDGET }) {
    validateSchema(schema);
    if (!Array.isArray(records)) {
      throw new TypeError('records must be an array');
    }
    this.schema = schema;
    this.records = records;
    this.budget = budget;
    this.versions = [];
    this.current = -1;
  }

  get schemaHash() {
    return sha256(stableStringify(this.schema));
  }

  // Runs a query end to end: lex -> parse -> normalize -> typecheck ->
  // compile -> execute under the instruction budget. On success a new
  // version is appended (truncating any redo tail). On any failure the
  // engine state is left untouched.
  run(query, { budget } = {}) {
    const effectiveBudget = budget === undefined ? this.budget : budget;
    const ast = normalize(parse(query));
    typecheck(ast, this.schema);
    const program = compile(ast);
    const { hits, instructions } = execute(program, this.records, this.schema, effectiveBudget);

    const canonicalAst = canonical(ast);
    const certificate = {
      version: this.current + 2,
      query,
      normalizedAst: canonicalAst,
      astHash: sha256(canonicalAst),
      schemaHash: this.schemaHash,
      budget: effectiveBudget,
      instructions,
      hits,
    };

    this.versions = this.versions.slice(0, this.current + 1);
    this.versions.push({ query, hits, certificate });
    this.current = this.versions.length - 1;
    return this.versions[this.current];
  }

  undo() {
    if (this.current > 0) {
      this.current -= 1;
    }
    return this.currentVersion();
  }

  redo() {
    if (this.current >= 0 && this.current < this.versions.length - 1) {
      this.current += 1;
    }
    return this.currentVersion();
  }

  currentVersion() {
    if (this.current < 0 || this.current >= this.versions.length) {
      return null;
    }
    return this.versions[this.current];
  }

  toJSON() {
    return {
      schema: this.schema,
      records: this.records,
      budget: this.budget,
      versions: this.versions,
      current: this.current,
    };
  }

  static fromJSON(data) {
    const engine = new EvidenceEngine({
      schema: data.schema,
      records: data.records,
      budget: data.budget,
    });
    engine.versions = data.versions || [];
    engine.current = typeof data.current === 'number' ? data.current : engine.versions.length - 1;
    return engine;
  }
}

module.exports = { EvidenceEngine, stableStringify, sha256, DEFAULT_BUDGET };
