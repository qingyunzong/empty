#!/usr/bin/env node
'use strict';

const { Series } = require('./src/timeseries.js');

function runCli(input) {
  let series;
  try {
    series = new Series({
      observations: input.observations ?? [],
      windows: input.windows ?? [],
      finalizeHorizon: input.finalizeHorizon ?? -Infinity,
    });
  } catch (err) {
    return { ok: false, code: err.code ?? 'E_INVALID', message: err.message };
  }

  const results = [];
  const operations = [];
  if (Array.isArray(input.corrections)) {
    operations.push({ type: 'correct', corrections: input.corrections });
  }
  if (Array.isArray(input.operations)) operations.push(...input.operations);

  for (const op of operations) {
    switch (op.type) {
      case 'correct': {
        const list = Array.isArray(op.corrections) ? op.corrections : [op.correction ?? op];
        results.push({ type: 'correct', results: series.applyCorrections(list) });
        break;
      }
      case 'undo':
        results.push({ type: 'undo', result: series.undo() });
        break;
      case 'redo':
        results.push({ type: 'redo', result: series.redo() });
        break;
      case 'setWindowLength':
        results.push({ type: 'setWindowLength', id: op.id, result: series.setWindowLength(op.id, op.length) });
        break;
      case 'observe':
        results.push({ type: 'observe', result: series.addObservation(op.observation ?? op) });
        break;
      default:
        results.push({ type: op.type, result: { ok: false, code: 'E_INVALID', message: `unknown operation ${op.type}` } });
    }
  }

  const state = series.state();
  return {
    ok: true,
    results,
    final: {
      observations: state.observations,
      windows: state.windows,
      historyDepth: state.historyDepth,
      redoDepth: state.redoDepth,
    },
    certificate: series.certificate(),
  };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, code: 'E_INVALID', message: 'stdin is not valid JSON' }) + '\n');
    process.exitCode = 1;
    return;
  }
  const output = runCli(input);
  if (!output.ok) process.exitCode = 1;
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    process.stdout.write(JSON.stringify({ ok: false, code: 'E_INTERNAL', message: String(err && err.message) }) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { runCli };
