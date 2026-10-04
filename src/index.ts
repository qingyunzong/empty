export type { Range, CaptureMatch } from './types';
export { parseTemplate, InvalidReferenceError, type TemplateToken } from './template';
export { findMatches } from './match';
export { SourceMap, type Segment } from './sourcemap';
export { replace, BudgetExceededError, type ReplaceOptions, type ReplaceResult } from './replace';
export {
  ReplaceSession,
  type PreImageSummary,
  type AppliedRound,
} from './session';
export { interpret } from './reference';
export { tagText, untag, taggedReplace, type TaggedChar } from './tagged';
