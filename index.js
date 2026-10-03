'use strict';

const { validateMachine, validateTaskCovers } = require('./src/dfa');
const { compare } = require('./src/equiv');
const { minCover } = require('./src/cover');
const { runCheck } = require('./src/run');
const { canonical, hashPlan, savePlan, loadPlan } = require('./src/plan');
const { InputError, PlanError } = require('./src/errors');

module.exports = {
  validateMachine,
  validateTaskCovers,
  compare,
  minCover,
  runCheck,
  canonical,
  hashPlan,
  savePlan,
  loadPlan,
  InputError,
  PlanError,
};
