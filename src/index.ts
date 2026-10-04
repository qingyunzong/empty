export {
  canonicalizeUrl,
  canonicalOffsetToOriginal,
  originalOffsetToCanonical,
  CanonicalizationError,
} from './canonicalize.js';
export type {
  Canonicalization,
  DerivationStep,
  QueryParamMapping,
  Span,
} from './canonicalize.js';
export { applyEditsAtomic, editForParamValue, replaceParamValues } from './replace.js';
export type { Edit } from './replace.js';
export { CanonicalizationCache } from './cache.js';
export { matchRoute } from './matcher.js';
export type { RouteMatch } from './matcher.js';
export { isUnreservedByte } from './percent.js';
