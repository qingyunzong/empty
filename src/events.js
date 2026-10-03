import { GateError } from './errors.js';

const KNOWN_TYPES = new Set(['release', 'freeze', 'revoke', 'reschedule']);

export function parseEvents(text) {
  const events = [];
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  lines.forEach((line, i) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      throw new GateError(`invalid JSON at event line ${i + 1}`, 1);
    }
    if (typeof ev.ts !== 'string') throw new GateError(`missing timestamp at event line ${i + 1}`, 1);
    if (typeof ev.type !== 'string' || !KNOWN_TYPES.has(ev.type)) {
      throw new GateError(`unknown event type at line ${i + 1}: ${ev.type}`, 1);
    }
    ev.seq = i + 1;
    events.push(ev);
  });
  for (let i = 1; i < events.length; i++) {
    if (events[i].ts < events[i - 1].ts) {
      throw new GateError(
        `time regression: event seq ${events[i].seq} ts ${events[i].ts} < ${events[i - 1].ts}`,
        5,
      );
    }
  }
  return events;
}
