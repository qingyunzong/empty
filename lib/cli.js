'use strict';

const fs = require('node:fs');
const { normalize, evaluateAll, InputError } = require('./model');
const { solve } = require('./solver');
const { publish } = require('./publish');

function main(argv) {
  const [cmd, inputPath, outputPath] = argv;
  if (cmd !== 'restate' || !inputPath || !outputPath) {
    process.stderr.write('usage: node . restate <input.json> <output.json>\n');
    return 2;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`cannot read input: ${e.message}\n`);
    return 1;
  }
  try {
    const model = normalize(raw);
    const r = solve(model);
    const entries = r.entries || [];
    const pub = publish(model, entries);
    const residuals = evaluateAll(model, entries, model.check);
    const out = {
      status: r.status,
      selection: entries,
      targetPeriods: [...new Set(entries.map((e) => e.period))],
      periods: model.periods.map((p) => ({ id: p.id, status: p.status })),
      layers: pub.layers,
      reversalTotal: pub.reversalTotal,
      conflicts: r.conflicts,
      balanced: residuals.every((x) => x.residual === 0),
      residuals,
      stats: { nodes: r.nodes, budget: model.budget },
    };
    fs.writeFileSync(outputPath, JSON.stringify(out, null, 2) + '\n');
    return 0;
  } catch (e) {
    if (e instanceof InputError) {
      try {
        fs.writeFileSync(
          outputPath,
          JSON.stringify({ status: 'ERROR', code: e.code, error: e.message }, null, 2) + '\n'
        );
      } catch {
        // ignore secondary write failure
      }
      process.stderr.write(`input error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

module.exports = { main };
