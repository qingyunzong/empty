import { createHash } from 'node:crypto';

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function eventHash(event) {
  const { hash, ...body } = event;
  return sha256(canonical(body));
}

export function makeEvent({ site, seq, clock = {}, type, order, data = {}, actor = null, ts = null }) {
  const vclock = { ...clock, [site]: seq };
  const event = { id: `${site}:${seq}`, site, seq, type, order, actor, data, vclock, ts };
  return { ...event, hash: eventHash(event) };
}
