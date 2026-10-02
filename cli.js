#!/usr/bin/env node
// CLI for the bitemporal equipment-state audit log.
//
//   node cli.js [--data DIR] append <batch.json|->
//   node cli.js [--data DIR] undo <tx_id>
//   node cli.js [--data DIR] asof <equipment> <valid_time> [tx_time]
//   node cli.js [--data DIR] counts [equipment]
//   node cli.js [--data DIR] hash
//   node cli.js [--data DIR] verify
//
// `asof` without a tx_time shows the current view (all corrections applied).

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Store, stableStringify } from './src/store.js';
import { ValidationError, parseTime } from './src/validate.js';
import { activeEvents, dailyCounts } from './src/reference.js';

const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);

// Runs one CLI invocation. `out`/`err` are line sinks; returns the exit code.
export function runCli(argv, { out = console.log, err = console.error } = {}) {
  let dataDir = process.env.AUDIT_DIR ?? 'data';
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data') {
      if (i + 1 >= argv.length) {
        err('ERROR --data requires a directory argument');
        return 2;
      }
      dataDir = argv[++i];
    } else {
      rest.push(argv[i]);
    }
  }
  const [cmd, ...args] = rest;

  const printDeltas = (deltas) => {
    if (deltas.length === 0) {
      out('DELTA (none)');
      return;
    }
    for (const d of deltas) {
      out(`DELTA equipment=${d.equipment} date=${d.date} up=${signed(d.up)} down=${signed(d.down)}`);
    }
  };

  try {
    const store = Store.open(dataDir);
    switch (cmd) {
      case 'append': {
        const file = args[0];
        if (!file) {
          err('ERROR usage: append <batch.json|->');
          return 2;
        }
        const text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
        let input;
        try {
          input = JSON.parse(text);
        } catch (parseErr) {
          err(`ERROR invalid JSON in ${file}: ${parseErr.message}`);
          return 2;
        }
        const txId = Array.isArray(input) ? input[0]?.tx_id ?? '?' : input?.tx_id ?? '?';
        try {
          const result = store.commit(input);
          out(`COMMIT tx_id=${result.txId} events=${result.eventCount}`);
          printDeltas(result.deltas);
          out(`HASH ${store.hash()}`);
          return 0;
        } catch (commitErr) {
          if (commitErr instanceof ValidationError) {
            out(`REJECT tx_id=${txId}`);
            for (const problem of commitErr.problems) out(`PROBLEM ${problem}`);
            out(`HASH ${store.hash()}`);
            return 1;
          }
          throw commitErr;
        }
      }
      case 'undo': {
        const txId = args[0];
        if (!txId) {
          err('ERROR usage: undo <tx_id>');
          return 2;
        }
        const deltas = store.undo(txId);
        out(`UNDO tx_id=${txId}`);
        printDeltas(deltas);
        out(`HASH ${store.hash()}`);
        return 0;
      }
      case 'asof': {
        const [equipment, validTime, txTime] = args;
        if (!equipment || !validTime) {
          err('ERROR usage: asof <equipment> <valid_time> [tx_time]');
          return 2;
        }
        const validMs = parseTime(validTime, 'valid_time');
        const txMs = txTime && txTime !== 'now' ? parseTime(txTime, 'tx_time') : Infinity;
        const state = store.engine.asOf(equipment, validMs, txMs);
        out(
          `STATE equipment=${equipment} valid_time=${validTime} tx_time=${txTime ?? 'CURRENT'} state=${state ?? 'NONE'}`,
        );
        return 0;
      }
      case 'counts': {
        const snapshot = store.engine.countsSnapshot();
        const equipments = args[0] ? [args[0]] : Object.keys(snapshot);
        let any = false;
        for (const equipment of equipments) {
          for (const [day, entry] of Object.entries(snapshot[equipment] ?? {})) {
            out(`COUNT equipment=${equipment} date=${day} up=${entry.up} down=${entry.down}`);
            any = true;
          }
        }
        if (!any) out('COUNT (empty)');
        return 0;
      }
      case 'hash': {
        out(`HASH ${store.hash()}`);
        return 0;
      }
      case 'verify': {
        const reference = dailyCounts(activeEvents(store.records));
        const incremental = store.engine.countsSnapshot();
        if (stableStringify(reference) === stableStringify(incremental)) {
          out(`VERIFY OK records=${store.records.length} (incremental counts == full-scan reference)`);
          return 0;
        }
        out('VERIFY MISMATCH');
        out(`reference=${stableStringify(reference)}`);
        out(`incremental=${stableStringify(incremental)}`);
        return 1;
      }
      default:
        err(`ERROR unknown command: ${cmd ?? '(none)'}`);
        return 2;
    }
  } catch (error) {
    err(`ERROR ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli(process.argv.slice(2)));
}
