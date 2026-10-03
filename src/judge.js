'use strict';

const { parseHistory, validateCommands } = require('./model');
const { findSchedule, findMinimalConflict } = require('./solver');

// Judge a history given as JSONL text.
// Returns { verdict: 'SAT', witness } or { verdict: 'UNSAT', conflict }.
// Throws JudgeError with code 12/13/14 for invalid interval / depends
// cycle / unknown command.
function judgeText(text, options = {}) {
  const { balances: fileBalances, commands } = parseHistory(text);
  const balances = { ...fileBalances, ...(options.balances || {}) };
  return judgeCommands(commands, balances);
}

function judgeCommands(commands, balances = {}) {
  validateCommands(commands);
  const witness = findSchedule(commands, balances);
  if (witness !== null) return { verdict: 'SAT', witness };
  const conflict = findMinimalConflict(commands, balances);
  return { verdict: 'UNSAT', conflict };
}

module.exports = { judgeText, judgeCommands };
