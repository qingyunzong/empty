import { YamlGraphError } from "./errors.ts";
import {
  createIdSource,
  DocumentParser,
  normalizeOptions,
  splitSourceLines,
} from "./parser.ts";
import { resolveDocument } from "./resolve.ts";
import type {
  BuildOptions,
  EntryProvenance,
  GraphMetadata,
  MappingEntry,
  MappingNode,
  NormalizedBuildOptions,
  ScalarNode,
  SequenceNode,
  ToJsOptions,
  YamlDocument,
  YamlNode,
} from "./types.ts";

const GRAPH_METADATA = Symbol.for("yaml-representation-graph.metadata");

export function parseYamlDocuments(
  source: string | Uint8Array,
  options: BuildOptions = {},
): YamlDocument[] {
  const text = sourceToString(source);
  const normalized = normalizeOptions(options);
  return parseDocumentList(text, normalized);
}

function parseDocumentList(
  text: string,
  normalized: NormalizedBuildOptions,
): YamlDocument[] {
  const lines = splitSourceLines(text);
  const ids = createIdSource();
  const documents: YamlDocument[] = [];
  let index = 0;
  while (index < lines.length) {
    while (
      index < lines.length &&
      (lines[index]!.content.trim().length === 0 ||
        lines[index]!.content === "..." ||
        lines[index]!.content.startsWith("... "))
    ) {
      index += 1;
    }
    if (index >= lines.length) break;
    const parser = new DocumentParser(lines, index, text, normalized, ids);
    const result = parser.parse();
    resolveDocument(result.document, normalized);
    documents.push(result.document);
    index = Math.max(result.endLine, index + 1);
  }
  return documents;
}

export function parseYamlGraph(
  source: string | Uint8Array,
  options: BuildOptions = {},
): YamlNode {
  const normalized = normalizeOptions(options);
  const text = sourceToString(source);
  const documents = parseDocumentList(text, normalized);
  if (documents.length === 0) {
    const lines = splitSourceLines(text);
    const parser = new DocumentParser(lines, 0, text, normalized, createIdSource());
    const result = parser.parse();
    resolveDocument(result.document, normalized);
    documents.push(result.document);
  }
  const index = normalized.documentIndex;
  if (index < 0 || index >= documents.length) {
    throw new RangeError(
      `Document index ${index} is out of range; document count is ${documents.length}`,
    );
  }
  const document = documents[index]!;
  return attachMetadata(document.root, {
    root: document.root,
    documents,
    anchors: document.anchors,
    aliases: document.aliases,
    cycles: document.cycles,
    nodes: document.nodes,
    stats: document.stats,
    source: document.source,
    options: normalized,
  });
}

export function attachMetadata(
  root: YamlNode,
  metadata: GraphMetadata,
): YamlNode {
  Object.defineProperty(root, GRAPH_METADATA, {
    value: metadata,
    enumerable: false,
    configurable: true,
  });
  const document = metadata.documents.find((item) => item.root === root);
  const properties: Record<string, unknown> = {
    root,
    meta: metadata,
    document,
    documents: metadata.documents,
    anchors: metadata.anchors,
    aliases: metadata.aliases,
    cycles: metadata.cycles,
    nodes: metadata.nodes,
    stats: metadata.stats,
    source: metadata.source,
    options: metadata.options,
  };
  for (const [key, value] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(root, key)) continue;
    Object.defineProperty(root, key, {
      value,
      enumerable: false,
      configurable: true,
    });
  }
  return root;
}

export function getGraphMetadata(root: YamlNode): GraphMetadata | undefined {
  return (root as YamlNode & { [GRAPH_METADATA]?: GraphMetadata })[
    GRAPH_METADATA
  ];
}

export class YamlGraph {
  readonly metadata: GraphMetadata;

  constructor(metadata: GraphMetadata) {
    this.metadata = metadata;
  }

  get root(): YamlNode {
    return this.metadata.root;
  }

  get documents(): YamlDocument[] {
    return this.metadata.documents;
  }

  get anchors(): ReadonlyMap<string, YamlNode> {
    return this.metadata.anchors;
  }

  get aliases() {
    return this.metadata.aliases;
  }

  get cycles() {
    return this.metadata.cycles;
  }

  get stats() {
    return this.metadata.stats;
  }

  get nodes(): YamlNode[] {
    return this.metadata.nodes;
  }

  get source(): string {
    return this.metadata.source;
  }

  get options(): NormalizedBuildOptions {
    return this.metadata.options;
  }

  get document(): YamlDocument | undefined {
    return this.documents[this.options.documentIndex];
  }

  toJS(options: ToJsOptions = {}): unknown {
    return toJS(this.root, options);
  }

  toValue(options: ToJsOptions = {}): unknown {
    return this.toJS(options);
  }

  toJSON(): unknown {
    return this.toJS();
  }

  getNode(path: string): YamlNode | undefined {
    return getNodeAtPath(this.root, path);
  }

  getEntry(path: string): MappingEntry | undefined {
    return getEntryAtPath(this.root, path);
  }

  trace(path: string): EntryProvenance[] {
    return traceField(this.root, path);
  }
}

export function createYamlGraph(
  source: string | Uint8Array,
  options: BuildOptions = {},
): YamlGraph {
  const root = parseYamlGraph(source, options);
  const metadata = getGraphMetadata(root);
  if (!metadata) {
    throw new Error("Internal graph metadata is missing");
  }
  return new YamlGraph(metadata);
}

export function toJS(node: YamlNode, options: ToJsOptions = {}): unknown {
  const shared = options.shared !== false;
  const cache = shared ? new Map<YamlNode, unknown>() : undefined;
  const active = new Map<YamlNode, unknown>();

  const convert = (current: YamlNode): unknown => {
    const activeValue = active.get(current);
    if (activeValue !== undefined) return activeValue;
    if (cache?.has(current)) return cache.get(current);
    if (current.kind === "scalar") {
      const value = current.value;
      cache?.set(current, value);
      return value;
    }
    if (current.kind === "sequence") {
      const result: unknown[] = [];
      cache?.set(current, result);
      active.set(current, result);
      for (const item of current.items) result.push(convert(item));
      active.delete(current);
      return result;
    }
    if (options.mapAs === "map") {
      const result = new Map<unknown, unknown>();
      cache?.set(current, result);
      active.set(current, result);
      for (const entry of current.entries) {
        result.set(convertKey(entry.key), convert(entry.value));
      }
      active.delete(current);
      return result;
    }
    const result: Record<string, unknown> = {};
    cache?.set(current, result);
    active.set(current, result);
    for (const entry of current.entries) {
      const key = String(convertKey(entry.key));
      result[key] = convert(entry.value);
    }
    if (options.withMetadata) {
      Object.defineProperties(result, {
        __nodeId: { value: current.id, enumerable: false },
        __anchor: { value: current.anchor, enumerable: false },
      });
    }
    active.delete(current);
    return result;
  };

  const convertKey = (current: YamlNode): unknown => {
    if (current.kind === "scalar") {
      if (current.value === null) return "null";
      return current.value;
    }
    return current.path;
  };

  const value = convert(node);
  return value;
}

export function walkYaml(
  root: YamlNode,
  visitor: (
    node: YamlNode,
    path: string,
    parent?: YamlNode,
    entry?: MappingEntry,
  ) => void,
): void {
  const visited = new Set<YamlNode>();
  const walk = (
    node: YamlNode,
    path: string,
    parent?: YamlNode,
    entry?: MappingEntry,
  ): void => {
    if (visited.has(node)) return;
    visited.add(node);
    visitor(node, path, parent, entry);
    if (node.kind === "sequence") {
      node.items.forEach((item, index) =>
        walk(item, `${path}[${index}]`, node),
      );
    } else if (node.kind === "mapping") {
      node.entries.forEach((item) =>
        walk(item.value, item.origin.targetPath, node, item),
      );
    }
  };
  walk(root, root.path);
}

export function getNodeAtPath(
  root: YamlNode,
  path: string,
): YamlNode | undefined {
  if (path === "$" || path === root.path) return root;
  const tokens = parsePath(path);
  let current: YamlNode | undefined = root;
  for (const token of tokens) {
    if (!current) return undefined;
    if (typeof token === "number") {
      if (current.kind !== "sequence") return undefined;
      current = current.items[token];
    } else if (current.kind === "mapping") {
      current = current.get(token);
    } else {
      return undefined;
    }
  }
  return current;
}

export function getEntryAtPath(
  root: YamlNode,
  path: string,
): MappingEntry | undefined {
  const tokens = parsePath(path);
  if (tokens.length === 0) return undefined;
  let current: YamlNode | undefined = root;
  for (let index = 0; index < tokens.length; index += 1) {
    if (!current) return undefined;
    const token = tokens[index]!;
    if (typeof token === "number") {
      if (current.kind !== "sequence") return undefined;
      current = current.items[token];
      continue;
    }
    if (current.kind !== "mapping") return undefined;
    if (index === tokens.length - 1) return current.getEntry(token);
    current = current.get(token);
  }
  return undefined;
}

export function traceField(
  root: YamlNode,
  path: string,
): EntryProvenance[] {
  return getEntryAtPath(root, path)?.provenance ?? [];
}

export const getProvenance = traceField;

function sourceToString(source: string | Uint8Array): string {
  const text =
    typeof source === "string"
      ? source
      : new TextDecoder("utf-8", { fatal: false }).decode(source);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parsePath(path: string): Array<string | number> {
  const result: Array<string | number> = [];
  const regex = /\.([A-Za-z_$][A-Za-z0-9_$-]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(path)) !== null) {
    if (match[1] !== undefined) result.push(match[1]);
    else if (match[2] !== undefined) result.push(Number(match[2]));
    else if (match[3] !== undefined) {
      result.push(JSON.parse(match[3]) as string);
    }
  }
  return result;
}

export function findNodeByAnchor(
  root: YamlNode,
  anchor: string,
): YamlNode | undefined {
  const metadata = getGraphMetadata(root);
  if (metadata) return metadata.anchors.get(anchor);
  let found: YamlNode | undefined;
  walkYaml(root, (node) => {
    if (!found && node.anchor === anchor) found = node;
  });
  return found;
}

export function isScalar(node: YamlNode): node is ScalarNode {
  return node.kind === "scalar";
}

export function isSequence(node: YamlNode): node is SequenceNode {
  return node.kind === "sequence";
}

export function isMapping(node: YamlNode): node is MappingNode {
  return node.kind === "mapping";
}

export function assertMapping(node: YamlNode, path = node.path): MappingNode {
  if (node.kind !== "mapping") {
    throw new YamlGraphError(
      "MERGE_TYPE",
      `Expected a mapping at ${path}; found ${node.kind}`,
      { path, range: node.range },
    );
  }
  return node;
}

export function assertSequence(node: YamlNode, path = node.path): SequenceNode {
  if (node.kind !== "sequence") {
    throw new YamlGraphError(
      "SYNTAX_ERROR",
      `Expected a sequence at ${path}; found ${node.kind}`,
      { path, range: node.range },
    );
  }
  return node;
}

export function assertScalar(node: YamlNode, path = node.path): ScalarNode {
  if (node.kind !== "scalar") {
    throw new YamlGraphError(
      "SYNTAX_ERROR",
      `Expected a scalar at ${path}; found ${node.kind}`,
      { path, range: node.range },
    );
  }
  return node;
}

export type { NormalizedBuildOptions };
