'use strict';

const { Engine } = require('./engine');
const { dispatch } = require('./dispatch');

// Run a raw stdin payload and return { status, output } where output is the
// JSON string the CLI would print. Kept separate from cli.js so tests can
// exercise the full CLI logic in-process.
function runCli(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return { status: 1, output: { error: 'E_INPUT', message: 'stdin is not valid JSON' } };
  }
  const ops = Array.isArray(input) ? input : input && input.ops;
  if (!Array.isArray(ops)) {
    return { status: 1, output: { error: 'E_INPUT', message: 'expected { "ops": [...] }' } };
  }
  const eng = new Engine();
  const results = ops.map((op) => dispatch(eng, op));
  return { status: 0, output: { results, final: eng.getSnapshot() } };
}

module.exports = { runCli };
