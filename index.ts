export {
  createYamlGraph,
  findNodeByAnchor,
  getEntryAtPath,
  getGraphMetadata,
  getNodeAtPath,
  getProvenance,
  isMapping,
  isScalar,
  isSequence,
  parseYamlDocuments,
  parseYamlGraph,
  toJS,
  traceField,
  walkYaml,
  YamlGraph,
} from "./src/graph.ts";
export { YamlGraphError, YamlSyntaxError } from "./src/errors.ts";
export { normalizeOptions } from "./src/parser.ts";

export type {
  AliasCycle,
  AliasRecord,
  BuildOptions,
  DuplicateKeyStrategy,
  EntryProvenance,
  GraphMetadata,
  GraphStats,
  MappingEntry,
  MappingNode,
  MergeTrace,
  NormalizedBuildOptions,
  Position,
  ScalarNode,
  ScalarStyle,
  ScalarValue,
  SequenceNode,
  SourceRange,
  ToJsOptions,
  YamlDocument,
  YamlNode,
  YamlNodeBase,
} from "./src/types.ts";

import { createYamlGraph, parseYamlGraph, toJS } from "./src/graph.ts";
import { parseYamlDocuments } from "./src/graph.ts";
import type { BuildOptions, YamlNode } from "./src/types.ts";

export const buildYamlGraph = parseYamlGraph;
export const buildRepresentationGraph = parseYamlGraph;
export const buildYamlRepresentationGraph = parseYamlGraph;
export const parseYamlToGraph = parseYamlGraph;
export const parseYaml = parseYamlGraph;
export const loadYaml = parseYamlGraph;
export const loadYamlGraph = parseYamlGraph;
export const parseYamlAll = parseYamlDocuments;
export const toValue = toJS;

export function parse(
  source: string | Uint8Array,
  options?: BuildOptions,
): YamlNode {
  return parseYamlGraph(source, options);
}

export default parseYamlGraph;
export const buildGraph = parseYamlGraph;
export const createGraph = createYamlGraph;
