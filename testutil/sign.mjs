import { crc32 } from '../src/crc32.js';
import { canonical } from '../src/canon.js';

// Build a valid frame: strips any crc, recomputes it over the canonical payload.
export function frame(obj) {
  const { crc, ...rest } = obj;
  return { ...rest, crc: crc32(canonical(rest)) };
}
