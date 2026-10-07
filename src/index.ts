export type {
  PathSegment,
  ResolvedSchema,
  RootSchema,
  Schema,
  ValidationError,
} from "./schema.js";
export { comparePaths, encodePath, resolveRef, sortErrors } from "./schema.js";
export { validate } from "./validate.js";
export { validateReference } from "./reference.js";
