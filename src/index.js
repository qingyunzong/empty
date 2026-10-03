'use strict';

const { EvidenceEngine, DEFAULT_BUDGET } = require('./engine');
const { tokenize } = require('./lexer');
const { parse } = require('./parser');
const { check } = require('./checker');
const { compile } = require('./compiler');
const { execute } = require('./vm');
const schema = require('./schema');
const errors = require('./errors');

module.exports = {
  EvidenceEngine,
  DEFAULT_BUDGET,
  tokenize,
  parse,
  check,
  compile,
  execute,
  ...schema,
  ...errors,
};
