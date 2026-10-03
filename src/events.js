'use strict';

const CANONICAL_EVENTS = ['apply', 'review', 'release', 'post', 'reverse'];

const ALIASES = new Map([
  ['申请', 'apply'],
  ['复核', 'review'],
  ['放行', 'release'],
  ['入账', 'post'],
  ['冲正', 'reverse'],
]);

function canonicalEvent(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (CANONICAL_EVENTS.includes(lower)) return lower;
  return ALIASES.get(trimmed) ?? null;
}

module.exports = { CANONICAL_EVENTS, canonicalEvent };
