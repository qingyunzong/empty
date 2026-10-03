'use strict';

const { tokenize } = require('./lexer');
const { parse } = require('./parser');
const { check } = require('./checker');
const { compile, materializeRegexes } = require('./compiler');
const { execute } = require('./vm');
const { validateSchema, hashSchema, canonicalize } = require('./schema');
const { QuerySchemaError } = require('./errors');

const DEFAULT_BUDGET = 10000;

function validateRecords(records) {
  if (!Array.isArray(records)) {
    throw new QuerySchemaError('records must be an array');
  }
  for (const record of records) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new QuerySchemaError('each record must be an object');
    }
    if (typeof record.id !== 'string' || record.id.length === 0) {
      throw new QuerySchemaError('each record must have a non-empty string id');
    }
  }
  return records;
}

class EvidenceEngine {
  constructor({ schema, records, budget = DEFAULT_BUDGET }) {
    this.schema = validateSchema(schema);
    this.records = validateRecords(records);
    this.schemaHash = hashSchema(this.schema);
    this.defaultBudget = budget;
    this.versions = [];
    this.cursor = -1;
  }

  query(queryString, budget = this.defaultBudget) {
    if (!Number.isInteger(budget) || budget < 0) {
      throw new QuerySchemaError(`budget must be a non-negative integer, got ${budget}`);
    }
    const tokens = tokenize(queryString);
    const ast = check(parse(tokens), this.schema);
    const bytecode = materializeRegexes(compile(ast, this.schema));
    const { hits, instructions } = execute(bytecode, this.records, this.schema, budget);
    this.versions = this.versions.slice(0, this.cursor + 1);
    const certificate = {
      version: this.versions.length + 1,
      query: queryString,
      ast: canonicalize(ast),
      schemaHash: this.schemaHash,
      budget,
      instructions,
      recordCount: this.records.length,
      hits,
    };
    this.versions.push(certificate);
    this.cursor = this.versions.length - 1;
    return certificate;
  }

  current() {
    return this.cursor >= 0 ? this.versions[this.cursor] : null;
  }

  undo() {
    if (this.cursor > 0) {
      this.cursor -= 1;
    }
    return this.current();
  }

  redo() {
    if (this.cursor >= 0 && this.cursor < this.versions.length - 1) {
      this.cursor += 1;
    }
    return this.current();
  }

  toJSON() {
    return {
      schemaHash: this.schemaHash,
      versions: this.versions,
      cursor: this.cursor,
    };
  }

  static fromState(state, { schema, records, budget }) {
    const engine = new EvidenceEngine({ schema, records, budget });
    if (state && typeof state === 'object') {
      if (state.schemaHash !== engine.schemaHash) {
        throw new QuerySchemaError(
          `state schema hash ${state.schemaHash} does not match schema hash ${engine.schemaHash}`
        );
      }
      engine.versions = Array.isArray(state.versions) ? state.versions : [];
      engine.cursor = Number.isInteger(state.cursor) ? state.cursor : engine.versions.length - 1;
      if (engine.cursor < -1 || engine.cursor >= engine.versions.length) {
        engine.cursor = engine.versions.length - 1;
      }
    }
    return engine;
  }
}

module.exports = { EvidenceEngine, DEFAULT_BUDGET };
