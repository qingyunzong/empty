export type {
  ConflictKind,
  ConflictResolution,
  FieldState,
  JsonPrimitive,
  JsonValue,
  ListMergeSpec,
  ListResolutionContext,
  ListRule,
  ListSpecInput,
  ListStrategyKind,
  MergeConflict,
  MergeIdentity,
  MergeKeySelector,
  MergePatch,
  MergeResult,
  PatchMerge,
  PatchRemove,
  PatchReplace,
  ThreeWayMergeOptions,
} from "./types.ts";

export {
  createMerger,
  computeMerge,
  computePatch,
  merge,
  merge3,
  ThreeWayMerger,
  threeWayMerge,
} from "./merge.ts";

export {
  applyMergePatch,
  applyPatch,
  createPatch,
  emptyPatch,
} from "./patch.ts";

export {
  MergeError,
  deepEqual,
  stableStringify,
} from "./utils.ts";
