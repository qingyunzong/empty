export type { OriginalPosition, ParsedSourceMap, Segment, SourceMapData } from './types.js';
export { decodeVlq, decodeVlqAll, encodeVlq } from './vlq.js';
export { parseMappings, parseSourceMap, serializeMappings, UNMAPPED } from './mappings.js';
export { greatestLowerBound, originalPositionFor } from './query.js';
export { composeSourceMaps } from './compose.js';
