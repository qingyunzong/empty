// Event model and input validation.
// InputError maps to CLI exit code 2 (bad JSON / duplicate id / invalid vector clock).

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
    this.exitCode = 2;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateVectorClock(vc) {
  if (!isPlainObject(vc)) {
    throw new InputError('invalid vector clock: must be an object mapping device -> counter');
  }
  for (const [key, value] of Object.entries(vc)) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new InputError('invalid vector clock: empty key');
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new InputError(`invalid vector clock: counter for "${key}" must be a non-negative safe integer`);
    }
  }
  return vc;
}

export function validateEvent(raw) {
  if (!isPlainObject(raw)) {
    throw new InputError('event must be a JSON object');
  }
  const { id, device, ts, vc, type } = raw;
  if (typeof id !== 'string' || id.length === 0) {
    throw new InputError('event.id must be a non-empty string');
  }
  if (typeof device !== 'string' || device.length === 0) {
    throw new InputError(`event ${id}: device must be a non-empty string`);
  }
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    throw new InputError(`event ${id}: ts must be a finite number`);
  }
  if (typeof type !== 'string' || type.length === 0) {
    throw new InputError(`event ${id}: type must be a non-empty string`);
  }
  try {
    validateVectorClock(vc);
  } catch (err) {
    throw new InputError(`event ${id}: ${err.message}`);
  }
  return { id, device, ts, vc: { ...vc }, type };
}

// Compare two vector clocks.
// Returns -1 (a happens-before b), 1 (b happens-before a), 0 (equal), null (concurrent).
export function compareVectorClocks(a, b) {
  let less = false;
  let greater = false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const av = a[key] ?? 0;
    const bv = b[key] ?? 0;
    if (av < bv) less = true;
    else if (av > bv) greater = true;
    if (less && greater) return null;
  }
  if (less && greater) return null;
  if (less) return -1;
  if (greater) return 1;
  return 0;
}
