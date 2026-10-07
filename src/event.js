export const EVENT_TYPES = new Set(['join', 'leave', 'interlock', 'reset', 'bypass', 'unbypass']);

export function validateEvent(e, source = 'event') {
  const fail = (msg) => {
    throw new Error(`invalid ${source}: ${msg}`);
  };
  if (typeof e !== 'object' || e === null || Array.isArray(e)) fail('not an object');
  for (const field of ['id', 'member', 'type']) {
    if (typeof e[field] !== 'string' || e[field] === '') fail(`field "${field}" must be a non-empty string`);
  }
  if (!EVENT_TYPES.has(e.type)) fail(`unknown type "${e.type}"`);
  if (!Number.isInteger(e.epoch) || e.epoch < 1) fail('epoch must be a positive integer');
  if (!Number.isInteger(e.seq) || e.seq < 1) fail('seq must be a positive integer');
  if (typeof e.clock !== 'object' || e.clock === null || Array.isArray(e.clock)) fail('clock must be an object');
  for (const [k, v] of Object.entries(e.clock)) {
    if (typeof k !== 'string' || k === '') fail('clock keys must be non-empty strings');
    if (!Number.isInteger(v) || v < 0) fail(`clock["${k}"] must be a non-negative integer`);
  }
  if ((e.type === 'bypass' || e.type === 'unbypass') && (typeof e.key !== 'string' || e.key === '')) {
    fail(`type "${e.type}" requires a non-empty "key"`);
  }
  return e;
}
