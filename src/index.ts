export type { Range, MatchInfo } from "./types.js";
export {
  InvalidCaptureError,
  InvalidMatchesError,
  BudgetExceededError,
} from "./errors.js";
export { parseTemplate, type TemplateToken } from "./template.js";
export { SourceMap, type Segment } from "./map.js";
export {
  replaceAll,
  type ReplaceOptions,
  type ReplaceResult,
} from "./replace.js";
export { findMatches } from "./find.js";
export { ReplaceSession } from "./session.js";
