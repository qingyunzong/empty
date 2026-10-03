// Event schema validation. Schema errors are fatal for the CLI (exit code 1).

export function validateEvent(event) {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    return 'event must be an object';
  }
  if (typeof event.id !== 'string' || event.id.length === 0) {
    return 'id must be a non-empty string';
  }
  if (typeof event.device !== 'string' || event.device.length === 0) {
    return 'device must be a non-empty string';
  }
  if (typeof event.ts !== 'number' || !Number.isFinite(event.ts)) {
    return 'ts must be a finite number';
  }
  if (event.state !== 'up' && event.state !== 'down') {
    return 'state must be "up" or "down"';
  }
  if (typeof event.node !== 'string' || event.node.length === 0) {
    return 'node must be a non-empty string';
  }
  if (typeof event.clock !== 'object' || event.clock === null || Array.isArray(event.clock)) {
    return 'clock must be an object mapping node names to counters';
  }
  for (const [key, value] of Object.entries(event.clock)) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return `clock["${key}"] must be a non-negative integer`;
    }
  }
  return null;
}

export function validateEvents(events) {
  if (!Array.isArray(events)) return ['payload must be an array of events'];
  const errors = [];
  events.forEach((event, index) => {
    const problem = validateEvent(event);
    if (problem) errors.push(`event[${index}]: ${problem}`);
  });
  return errors;
}
