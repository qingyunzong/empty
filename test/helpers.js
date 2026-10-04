'use strict';

const { signEvent, eventId } = require('../src/event');
const { fragmentMessage } = require('../src/protocol');

// Builds a signed event. Missing ref/qty/reason default to null.
function makeEvent(fields) {
  const e = { ref: null, qty: null, reason: null, ...fields };
  return { ...e, sig: signEvent(e) };
}

// Encodes events as hex frame lines (one message per event, msgId = index+1).
function toHexLines(events, { maxPayload = 1 << 30, duplicates = false } = {}) {
  const lines = [];
  events.forEach((e, i) => {
    for (const frame of fragmentMessage(i + 1, JSON.stringify(e), maxPayload)) {
      lines.push(frame.toString('hex'));
      if (duplicates) lines.push(frame.toString('hex')); // retransmitted frame
    }
  });
  return lines;
}

// Deterministic shuffle (fixed seed) so tests are reproducible.
function shuffled(arr) {
  const a = arr.slice();
  let seed = 0x2f6e2b1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function feedAll(ledger, events) {
  const snapshots = [];
  for (const e of events) {
    ledger.ingest(e);
    snapshots.push(JSON.stringify(ledger.preview().items));
  }
  return snapshots;
}

module.exports = { makeEvent, toHexLines, shuffled, feedAll, eventId };
