export {
  encode,
  encodeArg,
  decode,
  decodeSpans,
  assertNoNul,
  type ArgSpan,
} from "./quote.js";
export {
  expand,
  segmentsForRange,
  sourceSpans,
  segmentText,
  type Expanded,
  type Segment,
  type SourceSpan,
} from "./expand.js";
export {
  applyEdits,
  planEdits,
  type ArgEdit,
  type Conflict,
  type EditResult,
  type EditSuccess,
  type EditFailure,
  type Replacement,
} from "./edit.js";
