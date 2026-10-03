export class SchemaError extends Error {
  constructor(errors) {
    super(`schema validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    this.name = 'SchemaError';
    this.errors = errors;
  }
}

export function validateEvent(event, index = '?') {
  const errors = [];
  const at = (field) => `event[${index}].${field}`;
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return [`event[${index}]: must be an object`];
  }
  if (typeof event.id !== 'string' || event.id.length === 0) {
    errors.push(`${at('id')}: must be a non-empty string`);
  }
  if (typeof event.device !== 'string' || event.device.length === 0) {
    errors.push(`${at('device')}: must be a non-empty string`);
  }
  if (typeof event.ts !== 'number' || !Number.isFinite(event.ts)) {
    errors.push(`${at('ts')}: must be a finite number`);
  }
  if (event.state !== 'up' && event.state !== 'down') {
    errors.push(`${at('state')}: must be "up" or "down"`);
  }
  if (typeof event.node !== 'string' || event.node.length === 0) {
    errors.push(`${at('node')}: must be a non-empty string`);
  }
  if (event.end !== undefined && event.end !== null) {
    if (typeof event.end !== 'number' || !Number.isFinite(event.end)) {
      errors.push(`${at('end')}: must be a finite number when present`);
    } else if (typeof event.ts === 'number' && event.end < event.ts) {
      errors.push(`${at('end')}: must be >= ts`);
    }
  }
  const clock = event.clock;
  if (clock === null || typeof clock !== 'object' || Array.isArray(clock) || Object.keys(clock).length === 0) {
    errors.push(`${at('clock')}: must be a non-empty object of node -> counter`);
  } else {
    for (const [node, value] of Object.entries(clock)) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        errors.push(`${at(`clock.${node}`)}: must be a non-negative integer`);
      }
    }
  }
  return errors;
}

export function validateEvents(events) {
  const errors = [];
  if (!Array.isArray(events)) {
    throw new SchemaError(['payload must be a JSON array of events or NDJSON']);
  }
  events.forEach((event, index) => {
    errors.push(...validateEvent(event, index));
  });
  if (errors.length > 0) throw new SchemaError(errors);
  return events;
}
