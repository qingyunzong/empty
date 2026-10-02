// Schema and time validation. A batch is validated as a whole before anything
// is written, so an invalid batch never produces partial state.

export class ValidationError extends Error {
  constructor(problems) {
    super(problems.join('; '));
    this.name = 'ValidationError';
    this.problems = problems;
  }
}

// Date-only, or date-time with an explicit zone (Z or +-hh:mm). Timestamps
// without a zone are rejected to keep semantics independent of the host TZ.
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

export function isValidTimeString(value) {
  if (typeof value !== 'string' || !ISO_RE.test(value)) return false;
  const [datePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return false; // e.g. 2024-02-30
  }
  return !Number.isNaN(Date.parse(value));
}

export function parseTime(value, field = 'time') {
  if (!isValidTimeString(value)) {
    throw new ValidationError([`${field}: invalid timestamp ${JSON.stringify(value)}`]);
  }
  return Date.parse(value);
}

export const EVENT_FIELDS = ['id', 'equipment', 'valid_time', 'state', 'tx_id', 'tx_time'];
export const STATES = new Set(['up', 'down']);

function validateEvent(raw, index, problems) {
  const at = `events[${index}]`;
  const before = problems.length;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push(`${at}: expected an object`);
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!EVENT_FIELDS.includes(key)) problems.push(`${at}.${key}: unknown field`);
  }
  for (const field of ['id', 'equipment', 'tx_id']) {
    if (typeof raw[field] !== 'string' || raw[field].length === 0) {
      problems.push(`${at}.${field}: expected a non-empty string`);
    }
  }
  if (!STATES.has(raw.state)) {
    problems.push(`${at}.state: expected "up" or "down", got ${JSON.stringify(raw.state)}`);
  }
  for (const field of ['valid_time', 'tx_time']) {
    if (!isValidTimeString(raw[field])) {
      problems.push(`${at}.${field}: invalid timestamp ${JSON.stringify(raw[field])}`);
    }
  }
  if (problems.length !== before) return null;
  // Rebuild with fixed key order so hashing is canonical.
  return {
    id: raw.id,
    equipment: raw.equipment,
    valid_time: raw.valid_time,
    state: raw.state,
    tx_id: raw.tx_id,
    tx_time: raw.tx_time,
  };
}

// Accepts either an array of events (tx_id/tx_time taken from the events,
// which must be uniform) or an envelope {tx_id, tx_time, events:[...]}.
// Returns a normalized record {tx_id, tx_time, events} or throws
// ValidationError listing every problem found.
export function validateBatch(input) {
  const problems = [];
  let txId;
  let txTime;
  let rawEvents;
  const envelope = !Array.isArray(input);

  if (envelope) {
    if (input === null || typeof input !== 'object') {
      throw new ValidationError(['batch: expected an array or {tx_id, tx_time, events}']);
    }
    txId = input.tx_id;
    txTime = input.tx_time;
    rawEvents = input.events;
    if (typeof txId !== 'string' || txId.length === 0) {
      problems.push('tx_id: expected a non-empty string');
    }
    if (!isValidTimeString(txTime)) {
      problems.push(`tx_time: invalid timestamp ${JSON.stringify(txTime)}`);
    }
    if (!Array.isArray(rawEvents)) {
      problems.push('events: expected an array');
      rawEvents = [];
    }
  } else {
    rawEvents = input;
  }

  if (rawEvents.length === 0) {
    problems.push('events: batch must contain at least one event');
  }

  const events = [];
  rawEvents.forEach((raw, index) => {
    const event = validateEvent(raw, index, problems);
    if (event) events.push(event);
  });

  if (envelope) {
    events.forEach((event, i) => {
      if (typeof txId === 'string' && event.tx_id !== txId) {
        problems.push(`events[${i}].tx_id: ${JSON.stringify(event.tx_id)} does not match batch tx_id ${JSON.stringify(txId)}`);
      }
      if (typeof txTime === 'string' && event.tx_time !== txTime) {
        problems.push(`events[${i}].tx_time: ${JSON.stringify(event.tx_time)} does not match batch tx_time ${JSON.stringify(txTime)}`);
      }
    });
  } else if (events.length > 0) {
    txId = events[0].tx_id;
    txTime = events[0].tx_time;
    events.forEach((event, i) => {
      if (event.tx_id !== txId) {
        problems.push(`events[${i}].tx_id: all events in a batch must share one tx_id`);
      }
      if (event.tx_time !== txTime) {
        problems.push(`events[${i}].tx_time: all events in a batch must share one tx_time`);
      }
    });
  }

  if (problems.length > 0) throw new ValidationError(problems);
  return { tx_id: txId, tx_time: txTime, events };
}
