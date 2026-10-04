export {
  canonicalize,
  clone,
  deepEqual,
  digest,
  formatPath,
  getAtPath,
  isPlainObject,
  pathKey,
  type JsonObject,
  type JsonValue,
} from "./json.js";
export {
  indexResolutions,
  makeResolution,
  matchResolution,
  pickValue,
  type Choice,
  type MatchResult,
  type Resolution,
  type StaleReason,
} from "./resolution.js";
export { applyDiff, diff, type DiffOp } from "./diff.js";
export {
  merge3,
  type AppliedResolution,
  type ConflictInfo,
  type ConflictStatus,
  type MergeInput,
  type MergeResult,
} from "./merge.js";
