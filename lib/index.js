'use strict';

const { ParseError, parseSpec, ALLOWED_AMOUNTS, MAX_SUBJECTS, MAX_BOUND } = require('./spec');
const machine = require('./machine');
const search = require('./search');

module.exports = {
  ParseError,
  parseSpec,
  ALLOWED_AMOUNTS,
  MAX_SUBJECTS,
  MAX_BOUND,
  ...machine,
  ...search,
};
