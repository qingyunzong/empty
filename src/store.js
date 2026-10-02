'use strict';

const fs = require('node:fs');
const { CodedError } = require('./errors');

// Maximum tolerated reordering distance for event sequence numbers.
const ORDER_WINDOW = 100;

function loadEvents(path) {
  const events = [];
  const marks = new Map();
  let maxSeq = -Infinity;
  const lines = fs.readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  lines.forEach((line, i) => {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      throw new CodedError(2, `events line ${i + 1}: invalid JSON`);
    }
    if (typeof rec.seq !== 'number') throw new CodedError(2, `events line ${i + 1}: missing numeric 'seq'`);
    if (rec.seq < maxSeq - ORDER_WINDOW) {
      throw new CodedError(8, `events line ${i + 1}: seq ${rec.seq} is ${maxSeq - rec.seq} behind max seq ${maxSeq}, beyond window ${ORDER_WINDOW}`);
    }
    if (rec.seq > maxSeq) maxSeq = rec.seq;
    if (rec.type === 'fp_mark') marks.set(rec.eventId, rec);
    else events.push(rec);
  });
  const ids = new Set(events.map((e) => e.eventId));
  for (const [id] of marks) {
    if (!ids.has(id)) throw new CodedError(2, `fp_mark references unknown event '${id}'`);
  }
  return { events, marks, maxSeq: maxSeq === -Infinity ? 0 : maxSeq };
}

module.exports = { loadEvents, ORDER_WINDOW };
