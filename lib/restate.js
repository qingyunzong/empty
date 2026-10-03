'use strict';

const { validate, InputError } = require('./validate');
const { solveModel, minimalConflictCore, explainConflict } = require('./solver');
const { simulatePublish } = require('./publish');

function run(raw) {
  const model = validate(raw);
  const res = solveModel(model, model.budget);

  const out = {
    status: res.status,
    period: null,
    items: [],
    entry: null,
    layers: model.layers.map((l) => ({
      id: l.id,
      status: res.status === 'PENDING' ? 'HELD' : 'NOT_PUBLISHED',
      reserve: l.reserve,
      reversal: 0,
    })),
    reversals: 0,
    conflict: null,
    nodes: res.nodes,
    backtracks: res.backtracks,
    budget: model.budget,
  };

  if (res.status === 'OK') {
    const lines = [];
    for (let i = 0; i < model.items.length; i++) {
      if (res.delta[i] !== 0) {
        lines.push({ item: model.items[i].id, amount: res.delta[i] });
      }
    }
    const debits = lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
    const credits = lines.filter((l) => l.amount < 0).reduce((s, l) => s - l.amount, 0);
    out.period = res.period;
    out.items = lines.map((l) => l.item);
    out.entry = { period: res.period, lines, debits, credits, balanced: debits === credits };

    const pub = simulatePublish(model, res.delta);
    out.layers = pub.layers;
    out.reversals = pub.reversals;
    out.status = pub.ok ? 'OK' : 'ROLLED_BACK';
    return out;
  }

  if (res.status === 'UNSAT') {
    const core = minimalConflictCore(model);
    out.conflict = {
      formulas: core,
      explanation: explainConflict(model, core),
    };
  }
  return out;
}

module.exports = { run, InputError };
