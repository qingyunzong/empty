export { CanonicalError } from './errors.js';
export type { CanonicalValue, CanonicalObject } from './types.js';
export { encodeCanonical, obj } from './encoder.js';
export { encodeRecursive } from './recursive-encoder.js';
export { CanonicalParser, parseCanonical } from './parser.js';
export type { ParsedValue } from './parser.js';
export { digestCanonical, digestBytes } from './digest.js';
export { encodeVarint, decodeVarint } from './varint.js';
export { validateKey, compareKeysUtf8 } from './keys.js';
