export * from "./src/types.ts";
export { parseProto, looksLikeProtoSource } from "./src/proto-parser.ts";
export {
  normalizeSchema,
  inputToParsedSchemas,
  isNormalizedSchema,
} from "./src/normalize.ts";
export {
  compareSchemas,
  analyzeCompatibility,
  checkCompatibility,
  isCompatible,
  isBackwardCompatible,
  isForwardCompatible,
  isFullyCompatible,
} from "./src/compare.ts";
export {
  defaultJsonName,
  isPackable,
  isScalarType,
  scalarInfo,
  scalarNames,
  wireFamilyOf,
  wireTypeName,
  wireTypeOfScalar,
} from "./src/wire.ts";

import {
  compareSchemas,
  isBackwardCompatible,
  isForwardCompatible,
  isFullyCompatible,
  isCompatible,
} from "./src/compare.ts";
import { normalizeSchema } from "./src/normalize.ts";
import { parseProto } from "./src/proto-parser.ts";

export const compareProtobufSchemas = compareSchemas;
export const compareSchema = compareSchemas;
export const compareProtoSchemas = compareSchemas;
export const compareProto = compareSchemas;
export const analyze = compareSchemas;
export const analyzeSchemaEvolution = compareSchemas;
export const analyzeProtobufEvolution = compareSchemas;
export const analyzeProtobufCompatibility = compareSchemas;
export const analyzeEvolution = compareSchemas;
export const checkSchemaCompatibility = compareSchemas;
export const checkProtobufCompatibility = compareSchemas;
export const checkProtoCompatibility = compareSchemas;
export const checkEvolution = compareSchemas;
export const diffSchemas = compareSchemas;
export const diffProtoSchemas = compareSchemas;
export const detectBreakingChanges = compareSchemas;
export const evaluateCompatibility = compareSchemas;
export const evaluateSchemaEvolution = compareSchemas;
export const getCompatibility = compareSchemas;
export const compare = compareSchemas;
export const parseSchema = normalizeSchema;
export const parseProtoSchema = normalizeSchema;
export const parseProtobufSchema = normalizeSchema;
export const loadSchema = normalizeSchema;
export const checkBackwardCompatibility = isBackwardCompatible;
export const checkForwardCompatibility = isForwardCompatible;
export const checkBidirectionalCompatibility = isFullyCompatible;
export const getBreakingChanges = (
  oldInput: unknown,
  newInput: unknown,
  optionsOrDirection?: Parameters<typeof compareSchemas>[2],
) => compareSchemas(oldInput, newInput, optionsOrDirection).breakingChanges;
export const getMinimalBreakingPath = (
  oldInput: unknown,
  newInput: unknown,
  optionsOrDirection?: Parameters<typeof compareSchemas>[2],
) => compareSchemas(oldInput, newInput, optionsOrDirection).minimalBreakingPath;

const api = {
  parseProto,
  normalizeSchema,
  compareSchemas,
  analyzeCompatibility: compareSchemas,
  checkCompatibility: compareSchemas,
  isCompatible,
  isBackwardCompatible,
  isForwardCompatible,
  isFullyCompatible,
};

export default api;
