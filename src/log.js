import { readFileSync } from 'node:fs';
import { hashEvent } from './canonical.js';
import { AuditError, EXIT } from './errors.js';

export const GENESIS_PREV = '';

export function parseLog(text, source = '<log>') {
  const events = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      throw new AuditError(EXIT.USAGE, `${source}: line ${i + 1}: invalid JSON`);
    }
    if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
      throw new AuditError(EXIT.USAGE, `${source}: line ${i + 1}: event must be an object`);
    }
    for (const key of ['seq', 'prevHash', 'hash', 'body']) {
      if (!(key in ev)) throw new AuditError(EXIT.USAGE, `${source}: line ${i + 1}: missing field "${key}"`);
    }
    events.push(ev);
  }
  return events;
}

export function verifyEvents(events, source = '<log>') {
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const at = `position ${i + 1} (seq ${JSON.stringify(ev.seq)})`;
    if (!Number.isInteger(ev.seq) || ev.seq !== i + 1) {
      throw new AuditError(EXIT.BROKEN_CHAIN, `${source}: broken chain at ${at}: expected seq ${i + 1}`, i + 1);
    }
    const expectedPrev = i === 0 ? GENESIS_PREV : events[i - 1].hash;
    if (ev.prevHash !== expectedPrev) {
      throw new AuditError(EXIT.BROKEN_CHAIN, `${source}: broken chain at seq ${ev.seq}: prevHash mismatch`, ev.seq);
    }
    if (hashEvent(ev.prevHash, ev.body) !== ev.hash) {
      throw new AuditError(EXIT.BROKEN_CHAIN, `${source}: broken chain at seq ${ev.seq}: hash mismatch`, ev.seq);
    }
  }
  return true;
}

export function rootOf(events) {
  return events.length === 0 ? GENESIS_PREV : events[events.length - 1].hash;
}

export function loadLog(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new AuditError(EXIT.USAGE, `cannot read ${path}: ${err.message}`);
  }
  const events = parseLog(text, path);
  verifyEvents(events, path);
  return events;
}

export function serializeLog(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
}
