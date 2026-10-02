'use strict';

const model = require('./model');
const { evaluateRequest, evaluateInternal } = require('./evaluate');
const counterexample = require('./counterexample');

module.exports = {
  ...model,
  evaluateRequest,
  evaluateInternal,
  ...counterexample,
};
