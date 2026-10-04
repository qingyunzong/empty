'use strict';

const { parse, RegexError, MAX_RULE_LENGTH } = require('./src/regex');
const automata = require('./src/automata');
const ledger = require('./src/ledger');
const state = require('./src/state');

module.exports = {
  parse,
  RegexError,
  MAX_RULE_LENGTH,
  ...automata,
  ...ledger,
  ...state,
};
