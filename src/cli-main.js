'use strict';

const { Engine } = require('./engine');

// Pure CLI core: takes the raw stdin text, returns { status, out, err }.
function main(input) {
  try {
    const doc = JSON.parse(input);
    const ops = Array.isArray(doc) ? doc : doc.ops;
    if (!Array.isArray(ops)) throw new Error('input must be an op array or { "ops": [...] }');
    const engine = new Engine();
    const results = ops.map((op) => engine.apply(op));
    return { status: 0, out: JSON.stringify({ results, state: engine.snapshot() }, null, 2) + '\n', err: '' };
  } catch (err) {
    return { status: 1, out: '', err: `error: ${err.message}\n` };
  }
}

module.exports = { main };
