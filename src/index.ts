export type { Mapping, Segment, SourceMapData } from './types.js';
export { encodeVlq, decodeVlq } from './vlq.js';
export {
  compareSegments,
  indexMap,
  originalPositionFor,
  parseMappings,
  serializeMappings,
} from './mappings.js';
export type { IndexedMap } from './mappings.js';
export { compose } from './compose.js';
