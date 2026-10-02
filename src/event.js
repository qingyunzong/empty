export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class DuplicateIdError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DuplicateIdError';
  }
}

export function validateVectorClock(vc) {
  if (vc === null || typeof vc !== 'object' || Array.isArray(vc)) {
    throw new ValidationError('event.vc must be an object mapping device -> counter');
  }
  for (const [key, value] of Object.entries(vc)) {
    if (key.length === 0) {
      throw new ValidationError('event.vc keys must be non-empty device names');
    }
    if (!Number.isInteger(value) || value < 0) {
      throw new ValidationError(`event.vc["${key}"] must be a non-negative integer, got ${JSON.stringify(value)}`);
    }
  }
}

// Validates a raw event object and returns a normalized copy.
// Event shape: { id, device, ts, vc, type }.
export function validateEvent(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('event must be a JSON object');
  }
  const { id, device, ts, vc, type } = raw;
  if (typeof id !== 'string' || id.length === 0) {
    throw new ValidationError('event.id must be a non-empty string');
  }
  if (typeof device !== 'string' || device.length === 0) {
    throw new ValidationError(`event "${id}": device must be a non-empty string`);
  }
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    throw new ValidationError(`event "${id}": ts must be a finite number`);
  }
  if (typeof type !== 'string' || type.length === 0) {
    throw new ValidationError(`event "${id}": type must be a non-empty string`);
  }
  try {
    validateVectorClock(vc);
  } catch (err) {
    throw new ValidationError(`event "${id}": ${err.message}`);
  }
  return { id, device, ts, vc: { ...vc }, type };
}
