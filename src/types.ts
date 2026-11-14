export interface Position {
  offset: number;
  line: number;
  column: number;
}

export interface SourceRange {
  start: Position;
  end: Position;
}

export type ScalarStyle =
  | "plain"
  | "single-quoted"
  | "double-quoted"
  | "literal"
  | "folded"
  | "unknown";

export type ScalarValue = string | number | boolean | null;

export interface YamlNodeBase {
  readonly id: string;
  kind: "scalar" | "sequence" | "mapping";
  /** Compatibility alias for `kind`. */
  type: "scalar" | "sequence" | "mapping";
  /** Canonical YAML tag, for example `tag:yaml.org,2002:str`. */
  tag: string;
  /** The tag spelling used in the document, if one was present. */
  explicitTag?: string;
  anchor?: string;
  /** Path at which the node was first encountered. */
  path: string;
  range: SourceRange;
}

export interface ScalarNode extends YamlNodeBase {
  kind: "scalar";
  type: "scalar";
  value: ScalarValue;
  /** The unescaped scalar text before core-schema resolution. */
  raw: string;
  style: ScalarStyle;
  canonical: string;
}

export interface SequenceNode extends YamlNodeBase {
  kind: "sequence";
  type: "sequence";
  items: YamlNode[];
}

export interface MergeTrace {
  /** Path of the merge key that introduced this field. */
  path: string;
  keyRange?: SourceRange;
  /** Path of the mapping or sequence element used as the merge operand. */
  operandPath: string;
  sequenceIndex?: number;
  depth: number;
  sourceAnchor?: string;
  /** Anchor spelling used by the alias, when the operand was an alias. */
  aliasAnchor?: string;
}

export interface EntryProvenance {
  kind: "explicit" | "merge";
  /** Location in the source document where this value was written. */
  path: string;
  /** Path where this value appears (or appeared) in a mapping. */
  sourcePath: string;
  /** Path of the final mapping entry that received this value. */
  targetPath: string;
  mappingId: string;
  nodeId: string;
  anchor?: string;
  range: SourceRange;
  keyRange: SourceRange;
  merge?: MergeTrace;
  /** The winning provenance from the mapping that supplied a merged field. */
  mergedFrom?: EntryProvenance;
  /** True when a later/higher-precedence source replaced this contribution. */
  overridden: boolean;
}

export interface MappingEntry {
  key: YamlNode;
  value: YamlNode;
  keyText: string;
  explicit: boolean;
  merged: boolean;
  fromMerge: boolean;
  sourceKind: "explicit" | "merge";
  anchor?: string;
  sourceAnchor?: string;
  targetPath: string;
  merge?: MergeTrace;
  origin: EntryProvenance;
  /** Winner first, followed by overridden contributions. */
  provenance: EntryProvenance[];
  origins: EntryProvenance[];
  sources: EntryProvenance[];
  overridden: EntryProvenance[];
  source?: EntryProvenance;
  mergedFrom?: EntryProvenance;
}

export interface MappingNode extends YamlNodeBase {
  kind: "mapping";
  type: "mapping";
  entries: MappingEntry[];
  /** Entries exactly as parsed, before duplicate/merge resolution. */
  rawEntries?: MappingEntry[];
  provenance: Map<string, EntryProvenance[]>;
  get(key: string): YamlNode | undefined;
  getEntry(key: string): MappingEntry | undefined;
  provenanceFor(key: string): EntryProvenance[];
  trace(key: string): EntryProvenance[];
}

export type YamlNode = ScalarNode | SequenceNode | MappingNode;

export interface AliasRecord {
  anchor: string;
  path: string;
  target: YamlNode;
  targetPath: string;
  range: SourceRange;
  cycle?: AliasCycle;
}

export interface AliasCycle {
  anchor: string;
  /** Path where the back-reference occurs. */
  path: string;
  /** Path at which the anchor was defined. */
  targetPath: string;
  pathSegments: string[];
  message: string;
}

export interface GraphStats {
  nodes: number;
  scalars: number;
  sequences: number;
  mappings: number;
  aliases: number;
  aliasExpansionCost: number;
  maxDepth: number;
}

export interface YamlDocument {
  root: YamlNode;
  source: string;
  version: "1.2";
  anchors: ReadonlyMap<string, YamlNode>;
  aliases: AliasRecord[];
  cycles: AliasCycle[];
  nodes: YamlNode[];
  stats: GraphStats;
  directives: string[];
  range: SourceRange;
}

export type DuplicateKeyStrategy =
  | "error"
  | "first"
  | "last"
  | "reject"
  | "first-wins"
  | "last-wins";

export interface BuildOptions {
  /** Defaults to `error`. `reject` is an alias for `error`. */
  duplicateKeys?: DuplicateKeyStrategy;
  duplicateKey?: DuplicateKeyStrategy;
  duplicateKeyStrategy?: DuplicateKeyStrategy;
  duplicateKeyPolicy?: DuplicateKeyStrategy;
  onDuplicateKey?: DuplicateKeyStrategy;

  /** Maximum cumulative theoretical node expansion charged by aliases. */
  maxAliasExpansions?: number;
  /** Alias for `maxAliasExpansions`. */
  maxAliasCost?: number;
  /** Alias for `maxAliasExpansions`. */
  maxAliasExpansionCost?: number;
  /** Alias for `maxAliasExpansions`. */
  maxExpansionNodes?: number;
  maxAliasExpansion?: number;
  aliasExpansionLimit?: number;
  aliasBudget?: number;
  /** Maximum number of alias occurrences. */
  maxAliasCount?: number;
  /** Maximum graph depth, including aliases. */
  maxAliasDepth?: number;
  maxNodes?: number;
  maxDepth?: number;

  /** Defaults to `error`; `allow` preserves a cyclic shared graph. */
  onAliasCycle?: "error" | "allow" | "record";
  /** Alias for `onAliasCycle`. */
  cyclePolicy?: "error" | "allow" | "record";
  /** Convenience alias for `onAliasCycle: "allow"`. */
  allowCycles?: boolean;
  /** Set to false to keep `<<` as an ordinary key. */
  mergeKeys?: boolean;
  /** Alias for `mergeKeys`. */
  enableMerge?: boolean;
  /** Alias for `mergeKeys`. */
  merge?: boolean;
  /** Maximum nesting depth of merge operands. */
  maxMergeDepth?: number;
  /** Index of the document returned by `parseYamlGraph`. Defaults to 0. */
  documentIndex?: number;
}

export interface NormalizedBuildOptions {
  duplicateKeys: "error" | "first" | "last";
  maxAliasExpansions: number;
  maxAliasCount: number;
  maxAliasDepth: number;
  maxNodes: number;
  maxDepth: number;
  onAliasCycle: "error" | "allow";
  mergeKeys: boolean;
  maxMergeDepth: number;
  documentIndex: number;
}

export interface GraphMetadata {
  root: YamlNode;
  documents: YamlDocument[];
  anchors: ReadonlyMap<string, YamlNode>;
  aliases: AliasRecord[];
  cycles: AliasCycle[];
  nodes: YamlNode[];
  stats: GraphStats;
  source: string;
  options: NormalizedBuildOptions;
}

export interface ToJsOptions {
  /** Preserve graph sharing in the returned JavaScript value. Defaults to true. */
  shared?: boolean;
  /** Use a Map when mapping keys cannot be represented safely as object keys. */
  mapAs?: "object" | "map";
  /** Include node ids in object output. */
  withMetadata?: boolean;
}
