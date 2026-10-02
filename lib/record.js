import { recordHash } from './hash.js';

export const RECORD_TYPES = ['step', 'deviation', 'revoke', 'exit'];

// Merge vector clock `src` into `dst` (component-wise max), in place.
export function vcMerge(dst, src) {
  for (const [site, n] of Object.entries(src || {})) {
    if (typeof n !== 'number') continue;
    if (dst[site] === undefined || n > dst[site]) dst[site] = n;
  }
  return dst;
}

// Build a new record for `site` given the site's view of the world.
// knowledge: vector clock of everything the site has observed so far.
// prev: hash of the site's previous record, or null for genesis.
export function createRecord({ site, epoch, type, payload = null, target = null, scope = null, prev = null, knowledge = {} }) {
  if (!RECORD_TYPES.includes(type)) {
    throw new Error(`unknown record type: ${type}`);
  }
  if (type === 'revoke' && (typeof target !== 'string' || target.length === 0)) {
    throw new Error('revoke record requires a target hash');
  }
  const vc = vcMerge({}, knowledge);
  vc[site] = (vc[site] || 0) + 1;
  const rec = {
    v: 1,
    site,
    seq: vc[site],
    epoch,
    type,
    prev,
    vc,
    payload,
    target,
    scope,
  };
  rec.hash = recordHash(rec);
  return rec;
}
