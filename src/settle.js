'use strict';

const { validateProblem } = require('./validate');
const { solve } = require('./solver');

function settle(rawInput) {
  const problem = validateProblem(rawInput);
  return solve(problem);
}

module.exports = { settle };
