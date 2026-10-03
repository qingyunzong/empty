#!/usr/bin/env node
'use strict';

const { Series } = require('./src/series');

function run(spec) {
  const series = new Series({ finalizeHorizon: spec.finalizeHorizon });
  const events = [];
  const push = (cmd, res) => events.push({ cmd, ...res });

  for (const o of spec.observations || []) push('addObservation', series.addObservation(o && o.ts, o && o.value));
  for (const n of spec.nodes || []) push('addNode', series.addNode(n));
  for (const c of spec.corrections || []) push('correct', series.applyCorrection(c));

  for (const op of spec.ops || []) {
    if (!op || typeof op !== 'object') {
      events.push({ cmd: null, ok: false, error: 'E_INVALID' });
      continue;
    }
    switch (op.cmd) {
      case 'addObservation':
        push(op.cmd, series.addObservation(op.ts, op.value));
        break;
      case 'addNode':
        push(op.cmd, series.addNode(op));
        break;
      case 'setWindow':
        push(op.cmd, series.setWindow(op.node, op.window));
        break;
      case 'correct':
        push(op.cmd, Array.isArray(op.corrections)
          ? series.applyCorrections(op.corrections)
          : series.applyCorrection(op));
        break;
      case 'undo':
        push(op.cmd, series.undo());
        break;
      case 'redo':
        push(op.cmd, series.redo());
        break;
      case 'finalize':
        push(op.cmd, series.setFinalizeHorizon(op.horizon === undefined ? null : op.horizon));
        break;
      default:
        events.push({ cmd: op.cmd === undefined ? null : op.cmd, ok: false, error: 'E_UNKNOWN_CMD' });
    }
  }

  return { ok: true, events, state: series.snapshot() };
}

function main(input) {
  let spec;
  try {
    spec = JSON.parse(input.trim() === '' ? '{}' : input);
  } catch {
    return { status: 1, output: JSON.stringify({ ok: false, error: 'E_PARSE' }) + '\n' };
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { status: 1, output: JSON.stringify({ ok: false, error: 'E_INVALID' }) + '\n' };
  }
  return { status: 0, output: JSON.stringify(run(spec), null, 2) + '\n' };
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    const { status, output } = main(input);
    process.stdout.write(output);
    process.exitCode = status;
  });
}

module.exports = { run, main };
