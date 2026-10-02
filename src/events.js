'use strict';

const { ExitError, EXIT } = require('./model');

// Parse events.jsonl. Events must arrive within a reorder window: an event
// whose ts is more than `window` behind the max ts seen so far is rejected
// with exit code 8.
function parseEvents(text, window = 300) {
  const events = [];
  let maxTs = -Infinity;
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      throw new ExitError(EXIT.GENERIC, `events.jsonl line ${i + 1}: invalid JSON`);
    }
    if (typeof e.id !== 'string' || typeof e.ts !== 'number') {
      throw new ExitError(EXIT.GENERIC, `events.jsonl line ${i + 1}: each event needs a string "id" and numeric "ts"`);
    }
    if (e.ts < maxTs - window) {
      throw new ExitError(
        EXIT.OUT_OF_ORDER,
        `events.jsonl line ${i + 1}: event "${e.id}" ts=${e.ts} is out of order beyond window ${window} (max ts seen: ${maxTs})`
      );
    }
    if (e.ts > maxTs) maxTs = e.ts;
    events.push(e);
  }
  return events;
}

module.exports = { parseEvents };
