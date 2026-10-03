// TraceabilitySystem: event-sourced state rebuilt from the journal.
//
// Commands:
//   import file [layer]  -> validate + append a savepoint layer, report minStates
//   equiv A B            -> minimize both rule views, decide equivalence,
//                           emit the shortest distinguishing witness if any
//   rollback layer       -> truncate the journal back to the savepoint before
//                           that layer and recover

import fs from 'node:fs';
import { buildView } from './lineage.js';
import { findWitness, minimizeDfa } from './dfa.js';
import { appendRecord, readJournal, truncateJournal, truncateTornTail } from './journal.js';
import { LayerHoleError, ValidationError } from './errors.js';

export function parseBatchFile(path) {
  const text = fs.readFileSync(path, 'utf8');
  const records = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    try {
      records.push(JSON.parse(lines[i]));
    } catch {
      throw new ValidationError(`${path}:${i + 1}: invalid JSON record`);
    }
  }
  return records;
}

function splitRecords(records) {
  const starts = records
    .filter((r) => r !== null && typeof r === 'object' && r.meta === 'start')
    .map((r) => r.start);
  const batches = records.filter(
    (r) => r !== null && typeof r === 'object' && r.meta === undefined,
  );
  return { batches, start: starts.length > 0 ? starts[starts.length - 1] : undefined };
}

export function viewFromRecords(records) {
  const { batches, start } = splitRecords(records);
  return buildView(batches, { start });
}

export class TraceabilitySystem {
  constructor(journalPath) {
    this.journalPath = journalPath;
    this.recover();
  }

  recover() {
    const { layers, recoveredTo, discardedTail, tornOffset } = readJournal(this.journalPath);
    if (discardedTail) truncateTornTail(this.journalPath, tornOffset);
    this.layers = layers;
    this.recoveredTo = recoveredTo;
    this.discardedTail = discardedTail;
    this.batches = [];
    this.start = null;
    for (const layer of layers) {
      for (const rec of layer.records) {
        if (rec.type === 'batch') this.batches.push(rec.record);
        else if (rec.type === 'meta' && typeof rec.start === 'string') this.start = rec.start;
      }
    }
    return { recoveredTo: this.recoveredTo, discardedTail: this.discardedTail };
  }

  view() {
    return buildView(this.batches, { start: this.start ?? undefined });
  }

  minStates() {
    return minimizeDfa(this.view()).minStates;
  }

  importRecords(records, layer) {
    const next = this.recoveredTo + 1;
    if (layer !== undefined && layer !== next) {
      throw new LayerHoleError(`layer hole: expected layer ${next}, got layer ${layer}`);
    }
    const { batches, start } = splitRecords(records);
    const combined = [...this.batches, ...batches];
    // Validate the merged lineage before anything hits the journal.
    buildView(combined, { start: start ?? this.start ?? undefined });

    appendRecord(this.journalPath, { type: 'begin', layer: next });
    for (const record of batches) {
      appendRecord(this.journalPath, { type: 'batch', layer: next, record });
    }
    if (start !== undefined) {
      appendRecord(this.journalPath, { type: 'meta', layer: next, start });
    }
    appendRecord(this.journalPath, { type: 'commit', layer: next });

    this.recover();
    return {
      layer: next,
      batches: batches.length,
      minStates: this.minStates(),
      recoveredTo: this.recoveredTo,
    };
  }

  rollback(layer) {
    if (!Number.isInteger(layer) || layer < 1 || layer > this.recoveredTo) {
      throw new LayerHoleError(
        `cannot rollback layer ${layer}: current layer is ${this.recoveredTo}`,
      );
    }
    truncateJournal(this.journalPath, layer - 1);
    this.recover();
    return { recoveredTo: this.recoveredTo, minStates: this.minStates() };
  }
}

export function equivViews(viewA, viewB) {
  const minA = minimizeDfa(viewA);
  const minB = minimizeDfa(viewB);
  const witness = findWitness(minA.view, minB.view);
  return {
    equal: witness === null,
    witness,
    minStates: [minA.minStates, minB.minStates],
  };
}
