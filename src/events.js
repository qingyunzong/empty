import { GateError, EXIT } from './errors.js';

const KNOWN_TYPES = new Set(['release', 'freeze', 'revoke', 'reschedule']);

function normalizeEvent(obj, seq) {
  if (!obj || typeof obj !== 'object') {
    throw new GateError(`event ${seq}: must be a JSON object`, EXIT.USAGE);
  }
  if (!KNOWN_TYPES.has(obj.type)) {
    throw new GateError(`event ${seq}: unknown type "${obj.type}"`, EXIT.USAGE);
  }
  const ts = Date.parse(obj.ts);
  if (Number.isNaN(ts)) {
    throw new GateError(`event ${seq}: invalid ts "${obj.ts}"`, EXIT.USAGE);
  }
  const base = { seq, ts, type: obj.type, actor: obj.actor ?? 'planner' };
  switch (obj.type) {
    case 'release':
    case 'freeze':
      if (typeof obj.order !== 'string' || obj.order === '') {
        throw new GateError(`event ${seq}: missing order`, EXIT.USAGE);
      }
      return { ...base, order: obj.order, priority: obj.priority ?? 0 };
    case 'revoke':
      if (!Number.isInteger(obj.target)) {
        throw new GateError(`event ${seq}: revoke needs integer target`, EXIT.USAGE);
      }
      return { ...base, target: obj.target };
    case 'reschedule': {
      if (typeof obj.order !== 'string' || obj.order === '') {
        throw new GateError(`event ${seq}: missing order`, EXIT.USAGE);
      }
      const to = Date.parse(obj.to);
      if (Number.isNaN(to)) {
        throw new GateError(`event ${seq}: invalid to "${obj.to}"`, EXIT.USAGE);
      }
      return { ...base, order: obj.order, to };
    }
    default:
      throw new GateError(`event ${seq}: unsupported type`, EXIT.USAGE);
  }
}

// Parses release.jsonl text. Line number (1-based, skipping blanks) becomes seq.
export function parseEvents(text) {
  const events = [];
  let seq = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    seq += 1;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      throw new GateError(`event line ${seq}: invalid JSON`, EXIT.USAGE);
    }
    events.push(normalizeEvent(obj, seq));
  }
  return events;
}
