#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { ClearingEngine } from './src/engine.js';
import { ClearingError, CODES } from './src/errors.js';
import { canonPretty } from './src/canon.js';

const USAGE = 'usage: node cli.js <trades.json> <rates.json>';

// Synchronous write to fd 1: guarantees the payload is flushed before exit
// regardless of how stdout is piped.
function print(s) {
  writeSync(1, s + '\n');
}

async function main() {
  const [tradesPath, ratesPath] = process.argv.slice(2);
  if (!tradesPath || !ratesPath) {
    process.stderr.write(USAGE + '\n');
    process.exit(2);
  }

  let tradesDoc;
  let ratesDoc;
  try {
    tradesDoc = JSON.parse(await readFile(tradesPath, 'utf8'));
    ratesDoc = JSON.parse(await readFile(ratesPath, 'utf8'));
  } catch (e) {
    print(canonPretty({ status: 'error', error: { code: CODES.INVALID_INPUT, message: `cannot read input: ${e.message}` } }));
    process.exit(2);
  }

  try {
    if (!Array.isArray(ratesDoc.versions) || ratesDoc.versions.length === 0) {
      throw new ClearingError(CODES.INVALID_INPUT, 'rates.json must contain a non-empty "versions" array');
    }
    const engine = new ClearingEngine({
      base: ratesDoc.base,
      limits: tradesDoc.limits ?? null,
      capacity: tradesDoc.capacity ?? null,
    });
    for (const v of ratesDoc.versions) engine.addRateVersion(v.version, v.rates);
    engine.setTrades(tradesDoc.trades ?? []);
    for (const id of tradesDoc.void ?? []) engine.voidTrade(id);
    const result = engine.settle(
      tradesDoc.ratesVersion !== undefined ? { ratesVersion: tradesDoc.ratesVersion } : {},
    );
    print(canonPretty({ status: 'ok', ...result }));
  } catch (e) {
    if (e instanceof ClearingError) {
      const error = { code: e.code, message: e.message };
      if (e.details !== undefined) error.details = e.details;
      print(canonPretty({ status: 'error', error }));
      process.exit(e.code === CODES.INVALID_INPUT ? 2 : 1);
    }
    throw e;
  }
}

main();
