// CLI core, separated from process I/O so it can be driven in-process by tests.
import { readFileSync } from 'node:fs';
import { NettingEngine } from './engine.js';
import { NettingError, ErrorCodes } from './errors.js';

const pretty = (value) => JSON.stringify(value, null, 2) + '\n';

export function runCli(argv, { readFile = readFileSync } = {}) {
  const [tradesPath, ratesPath] = argv;
  if (!tradesPath || !ratesPath) {
    return { status: 2, stdout: '', stderr: 'usage: node cli.js <trades.json> <rates.json>\n' };
  }

  let tradesDoc;
  let ratesDoc;
  try {
    tradesDoc = JSON.parse(readFile(tradesPath, 'utf8'));
  } catch (e) {
    return errorResult(`cannot read trades file ${tradesPath}: ${e.message}`);
  }
  try {
    ratesDoc = JSON.parse(readFile(ratesPath, 'utf8'));
  } catch (e) {
    return errorResult(`cannot read rates file ${ratesPath}: ${e.message}`);
  }

  try {
    const engine = new NettingEngine({
      rates: ratesDoc,
      limits: tradesDoc.limits ?? null,
      windowCapacity: tradesDoc.windowCapacity ?? null,
    });
    engine.addTrades(tradesDoc.trades ?? []);
    const result = engine.settle({ ratesVersion: tradesDoc.ratesVersion });
    return { status: 0, stdout: pretty(result), stderr: '' };
  } catch (e) {
    if (e instanceof NettingError) {
      return { status: 1, stdout: pretty({ ok: false, error: e.toJSON() }), stderr: '' };
    }
    throw e;
  }
}

function errorResult(message) {
  return {
    status: 1,
    stdout: pretty({ ok: false, error: { code: ErrorCodes.INPUT_INVALID, message } }),
    stderr: '',
  };
}
