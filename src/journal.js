'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { GenealogyError } = require('./genealogy');

// The journal is the single source of truth. Layout (JSONL):
//   {"type":"begin","layer":N,"count":K}
//   {"type":"record","layer":N,"data":{...}}   x K
//   {"type":"commit","layer":N}
// Every line is fsync'd before the next is written, so the recovery point is
// exactly "after each record's fsync". A crash mid-layer leaves a torn tail
// (missing records or missing commit); recovery replays complete layers only.

function appendLineFsync(file, obj) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(obj) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Returns { layers: [[record,...],...], recoveredTo }.
// A begin whose layer number is not exactly (number of complete layers)+1 is
// a layer hole -> GenealogyError kind LAYER_HOLE (exit code 4).
// A torn tail (bad JSON, missing records, missing commit) is discarded.
function readJournal(file) {
  if (!fs.existsSync(file)) return { layers: [], recoveredTo: 0 };
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const layers = [];
  let i = 0;
  let expected = 1;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) break;
    let head;
    try {
      head = JSON.parse(line);
    } catch {
      break; // torn write
    }
    if (head.type !== 'begin') break; // stray record: torn tail
    if (head.layer !== expected) {
      throw new GenealogyError(
        'LAYER_HOLE',
        `layer hole: expected layer ${expected}, found layer ${head.layer}`
      );
    }
    const records = [];
    let complete = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) break;
      let rec;
      try {
        rec = JSON.parse(l);
      } catch {
        break; // torn write
      }
      if (rec.type === 'commit' && rec.layer === expected) {
        complete = records.length === head.count;
        j++;
        break;
      }
      if (rec.type === 'record' && rec.layer === expected) {
        records.push(rec.data);
      } else {
        break; // unexpected entry: treat the rest as torn
      }
    }
    if (!complete) break; // crashed mid-layer: discard incomplete layer
    layers.push(records);
    expected++;
    i = j;
  }
  return { layers, recoveredTo: layers.length };
}

// Append one complete layer; each line fsync'd individually.
function appendLayer(file, layer, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  appendLineFsync(file, { type: 'begin', layer, count: records.length });
  for (const data of records) appendLineFsync(file, { type: 'record', layer, data });
  appendLineFsync(file, { type: 'commit', layer });
  return layer;
}

// Rewrite the journal keeping only the given layers (rollback). Written to a
// temp file, fsync'd, then atomically renamed over the old journal.
function rewriteJournal(file, layers) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    layers.forEach((records, idx) => {
      const layer = idx + 1;
      fs.writeSync(fd, JSON.stringify({ type: 'begin', layer, count: records.length }) + '\n');
      for (const data of records) {
        fs.writeSync(fd, JSON.stringify({ type: 'record', layer, data }) + '\n');
      }
      fs.writeSync(fd, JSON.stringify({ type: 'commit', layer }) + '\n');
    });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

module.exports = { appendLineFsync, readJournal, appendLayer, rewriteJournal };
