// Positional index: term -> sorted positions, delta-encoded as varints,
// stored base64 inside the segment file.

import { encodeVarint, decodeVarints } from './varint.js';

export function buildIndex(tokens) {
  const map = new Map();
  tokens.forEach((token, position) => {
    if (!map.has(token)) map.set(token, []);
    map.get(token).push(position);
  });
  const index = {};
  for (const [token, positions] of [...map.entries()].sort()) {
    index[token] = encodePostings(positions);
  }
  return index;
}

export function encodePostings(positions) {
  const bytes = [];
  let prev = 0;
  positions.forEach((position, i) => {
    bytes.push(...encodeVarint(i === 0 ? position : position - prev));
    prev = position;
  });
  return Buffer.from(bytes).toString('base64');
}

export function decodePostings(b64) {
  const deltas = decodeVarints(Buffer.from(b64, 'base64'));
  const positions = [];
  let acc = 0;
  for (const delta of deltas) {
    acc += delta;
    positions.push(acc);
  }
  return positions;
}

export function decodeIndex(index) {
  const decoded = {};
  for (const [token, b64] of Object.entries(index)) {
    decoded[token] = decodePostings(b64);
  }
  return decoded;
}

// Phrase match on a decoded positional index: tokens must be adjacent.
export function phraseMatch(decodedIndex, phraseTokens) {
  if (phraseTokens.length === 0) return false;
  let starts = decodedIndex[phraseTokens[0]] ?? [];
  for (let k = 1; k < phraseTokens.length && starts.length > 0; k++) {
    const positions = new Set(decodedIndex[phraseTokens[k]] ?? []);
    starts = starts.filter((start) => positions.has(start + k));
  }
  return starts.length > 0;
}
