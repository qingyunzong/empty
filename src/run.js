'use strict';

const { FormulaStore } = require('./versioning');
const { FormulaError } = require('./errors');

function runCommand(store, cmd) {
  switch (cmd.op) {
    case 'correct':
      return { ok: true, op: 'correct', ...store.correct(cmd.formula) };
    case 'undo':
      return { ok: true, op: 'undo', current: store.undo() };
    case 'redo':
      return { ok: true, op: 'redo', current: store.redo() };
    case 'status':
      return { ok: true, op: 'status', current: store.current() };
    case 'enumerate':
      return { ok: true, op: 'enumerate', subexpressions: store.enumerate() };
    default:
      throw new FormulaError('BAD_COMMAND', `unknown command op "${cmd.op}"`);
  }
}

// Execute a parsed JSON spec; failed commands leave the store state unchanged.
function runSpec(spec) {
  const store = new FormulaStore(spec.variables || {});
  const results = (spec.commands || []).map((cmd) => {
    try {
      return runCommand(store, cmd);
    } catch (err) {
      if (err instanceof FormulaError) return { ok: false, op: cmd.op, error: err.toJSON() };
      return { ok: false, op: cmd.op, error: { code: 'INTERNAL', message: err.message } };
    }
  });
  return { ok: true, results };
}

module.exports = { runSpec };
