import { YamlGraphError } from "./errors.ts";
import { keyIdentity } from "./scalar.ts";
import type {
  AliasRecord,
  EntryProvenance,
  MappingEntry,
  MappingNode,
  MergeTrace,
  NormalizedBuildOptions,
  YamlDocument,
  YamlNode,
} from "./types.ts";

interface ResolverContext {
  document: YamlDocument;
  options: NormalizedBuildOptions;
  aliasesByPath: Map<string, AliasRecord[]>;
}

interface MergeOperand {
  mapping: MappingNode;
  operandPath: string;
  sequenceIndex?: number;
}

interface Candidate {
  entry: MappingEntry;
  provenance: EntryProvenance;
}

export function resolveDocument(
  document: YamlDocument,
  options: NormalizedBuildOptions,
): void {
  const aliasesByPath = new Map<string, AliasRecord[]>();
  for (const alias of document.aliases) {
    const list = aliasesByPath.get(alias.path);
    if (list) list.push(alias);
    else aliasesByPath.set(alias.path, [alias]);
  }
  const resolver = new GraphResolver({ document, options, aliasesByPath });
  resolver.resolve();
  document.stats.aliasExpansionCost = resolver.aliasExpansionCost;
  document.stats.maxDepth = Math.max(
    document.stats.maxDepth,
    resolver.graphDepth,
  );
}

class GraphResolver {
  private readonly document: YamlDocument;
  private readonly options: NormalizedBuildOptions;
  private readonly aliasesByPath: Map<string, AliasRecord[]>;
  private readonly resolvedMappings = new Set<MappingNode>();
  private readonly resolvingMappings = new Set<MappingNode>();
  private readonly resolvedNodes = new Set<YamlNode>();
  private readonly visitingNodes = new Set<YamlNode>();
  private readonly weightCache = new Map<YamlNode, number>();
  aliasExpansionCost = 0;
  graphDepth = 0;

  constructor(context: ResolverContext) {
    this.document = context.document;
    this.options = context.options;
    this.aliasesByPath = context.aliasesByPath;
  }

  resolve(): void {
    this.resolveNode(this.document.root, this.document.root.path, [], 0);
    this.enforceAliasBudget();
  }

  private resolveNode(
    node: YamlNode,
    path: string,
    mergeStack: string[],
    depth: number,
  ): void {
    this.graphDepth = Math.max(this.graphDepth, depth);
    if (depth > this.options.maxDepth) {
      throw new YamlGraphError(
        "MAX_DEPTH",
        `Maximum graph depth exceeded at ${path}: ${depth} > ${this.options.maxDepth}`,
        { path, actual: depth, limit: this.options.maxDepth },
      );
    }
    if (node.kind === "scalar") {
      this.resolvedNodes.add(node);
      return;
    }
    if (this.resolvedNodes.has(node)) return;
    if (this.visitingNodes.has(node)) return;
    this.visitingNodes.add(node);
    try {
      if (node.kind === "sequence") {
        for (let i = 0; i < node.items.length; i += 1) {
          this.resolveNode(node.items[i]!, `${path}[${i}]`, mergeStack, depth + 1);
        }
      } else {
        this.resolveMapping(node, path, mergeStack, depth);
        for (const entry of node.entries) {
          this.resolveNode(
            entry.value,
            entry.origin.sourcePath,
            mergeStack,
            depth + 1,
          );
        }
      }
      this.resolvedNodes.add(node);
    } finally {
      this.visitingNodes.delete(node);
    }
  }

  private resolveMapping(
    mapping: MappingNode,
    path: string,
    mergeStack: string[],
    depth: number,
  ): void {
    if (this.resolvedMappings.has(mapping)) return;
    if (this.resolvingMappings.has(mapping)) {
      const cyclePath = [...mergeStack, mapping.path].join(" -> ");
      throw new YamlGraphError(
        "MERGE_CYCLE",
        `Merge cycle detected: ${cyclePath}`,
        {
          path,
          cycle: {
            anchor: mapping.anchor ?? "",
            path,
            targetPath: mapping.path,
            pathSegments: [path, mapping.path],
            message: `Merge cycle: ${cyclePath}`,
          },
        },
      );
    }
    this.resolvingMappings.add(mapping);
    try {
      const rawEntries = mapping.rawEntries ?? mapping.entries.slice();
      const mergeRaw = rawEntries.filter((entry) =>
        isMergeEntry(entry, this.options),
      );
      const explicitRaw = rawEntries.filter(
        (entry) => !isMergeEntry(entry, this.options),
      );
      const explicit = this.resolveExplicit(explicitRaw, mapping, path);
      const finalEntries = explicit.entries;
      const seen = new Map<string, MappingEntry>();
      for (const entry of finalEntries) {
        seen.set(keyIdentity(entry.key), entry);
      }

      const selectedMerges = applyMergeKeyStrategy(mergeRaw, this.options, path);
      for (const mergeEntry of selectedMerges) {
        const mergePath = pathForKey(path, "<<");
        const operands = this.collectMergeOperands(
          mergeEntry.value,
          mergePath,
          mergePath,
          1,
        );
        for (const operand of operands) {
          this.resolveMapping(
            operand.mapping,
            operand.operandPath,
            [...mergeStack, mergePath],
            depth + 1,
          );
          const alias =
            operand.mapping.path !== operand.operandPath
              ? this.takeAlias(operand.operandPath, operand.mapping)
              : undefined;
          for (const sourceEntry of operand.mapping.entries) {
            const identity = keyIdentity(sourceEntry.key);
            const targetPath = pathForKey(path, sourceEntry.keyText);
            const sourceAnchor =
              operand.mapping.anchor ?? sourceEntry.anchor ?? sourceEntry.value.anchor;
            const provenance = this.makeMergeProvenance(
              sourceEntry,
              mapping,
              targetPath,
              mergePath,
              operand.operandPath,
              operand.sequenceIndex,
              alias?.anchor,
              sourceAnchor,
              mergeEntry.key.range,
            );
            const existing = seen.get(identity);
            if (!existing) {
              const entry = cloneForMerge(sourceEntry, provenance, targetPath);
              seen.set(identity, entry);
              finalEntries.push(entry);
            } else {
              provenance.overridden = true;
              existing.provenance.push(provenance);
              existing.overridden.push(provenance);
              existing.sources = existing.provenance;
              existing.origins = existing.provenance;
            }
          }
        }
      }

      mapping.entries = finalEntries;
      mapping.rawEntries = rawEntries;
      mapping.provenance.clear();
      for (const entry of finalEntries) {
        mapping.provenance.set(entry.keyText, entry.provenance);
      }
      this.resolvedMappings.add(mapping);
    } finally {
      this.resolvingMappings.delete(mapping);
    }
  }

  private resolveExplicit(
    rawEntries: MappingEntry[],
    mapping: MappingNode,
    path: string,
  ): { entries: MappingEntry[] } {
    const byIdentity = new Map<string, MappingEntry>();
    const order: MappingEntry[] = [];
    for (const raw of rawEntries) {
      const identity = keyIdentity(raw.key);
      const targetPath = pathForKey(path, raw.keyText);
      const provenance = this.makeExplicitProvenance(raw, mapping, targetPath);
      const existing = byIdentity.get(identity);
      if (!existing) {
        const entry = cloneExplicit(raw, provenance, targetPath);
        byIdentity.set(identity, entry);
        order.push(entry);
        continue;
      }
      if (this.options.duplicateKeys === "error") {
        throw new YamlGraphError(
          "DUPLICATE_KEY",
          `Duplicate key ${JSON.stringify(raw.keyText)} at ${targetPath}; first defined at line ${existing.key.range.start.line}, column ${existing.key.range.start.column}`,
          {
            path: targetPath,
            key: raw.keyText,
            range: raw.key.range,
            firstRange: existing.key.range,
          },
        );
      }
      if (this.options.duplicateKeys === "first") {
        provenance.overridden = true;
        existing.provenance.push(provenance);
        existing.overridden.push(provenance);
        existing.sources = existing.provenance;
        existing.origins = existing.provenance;
        continue;
      }
      for (const previous of existing.provenance) previous.overridden = true;
      existing.key = raw.key;
      existing.value = raw.value;
      existing.anchor = raw.value.anchor;
      existing.provenance = [provenance, ...existing.provenance];
      existing.sources = existing.provenance;
      existing.origins = existing.provenance;
      existing.overridden = existing.provenance.slice(1);
      existing.origin = provenance;
      existing.source = provenance;
      existing.mergedFrom = undefined;
    }
    return { entries: order };
  }

  private collectMergeOperands(
    value: YamlNode,
    mergePath: string,
    path: string,
    depth: number,
  ): MergeOperand[] {
    if (depth > this.options.maxMergeDepth) {
      throw new YamlGraphError(
        "MERGE_DEPTH",
        `Merge depth exceeded at ${mergePath}: ${depth} > ${this.options.maxMergeDepth}`,
        { path: mergePath, actual: depth, limit: this.options.maxMergeDepth },
      );
    }
    if (value.kind === "mapping") {
      return [{ mapping: value, operandPath: path }];
    }
    if (value.kind === "sequence") {
      const operands: MergeOperand[] = [];
      for (let i = 0; i < value.items.length; i += 1) {
        const item = value.items[i]!;
        const itemPath = `${mergePath}[${i}]`;
        if (item.kind !== "mapping") {
          throw new YamlGraphError(
            "MERGE_TYPE",
            `Merge operands must be mappings; found ${item.kind} at ${itemPath}`,
            { path: itemPath, range: item.range },
          );
        }
        operands.push({
          mapping: item,
          operandPath: itemPath,
          sequenceIndex: i,
        });
      }
      return operands;
    }
    throw new YamlGraphError(
      "MERGE_TYPE",
      `Merge value at ${mergePath} must be a mapping or a sequence of mappings; found ${value.kind}`,
      { path: mergePath, range: value.range },
    );
  }

  private makeExplicitProvenance(
    raw: MappingEntry,
    mapping: MappingNode,
    targetPath: string,
  ): EntryProvenance {
    return {
      kind: "explicit",
      path: raw.value.path,
      sourcePath: raw.value.path,
      targetPath,
      mappingId: mapping.id,
      nodeId: raw.value.id,
      anchor: mapping.anchor ?? raw.value.anchor,
      range: raw.value.range,
      keyRange: raw.key.range,
      overridden: false,
    };
  }

  private takeAlias(
    path: string,
    target: YamlNode,
  ): AliasRecord | undefined {
    const list = this.aliasesByPath.get(path);
    if (!list) return undefined;
    const index = list.findIndex((alias) => alias.target === target);
    if (index < 0) return undefined;
    return list.splice(index, 1)[0];
  }

  private makeMergeProvenance(
    sourceEntry: MappingEntry,
    mapping: MappingNode,
    targetPath: string,
    mergePath: string,
    operandPath: string,
    sequenceIndex: number | undefined,
    aliasAnchor: string | undefined,
    sourceAnchor: string | undefined,
    keyRange: EntryProvenance["keyRange"],
  ): EntryProvenance {
    const mergedFrom = sourceEntry.origin;
    const mergeTrace: MergeTrace = {
      path: mergePath,
      keyRange,
      operandPath,
      sequenceIndex,
      depth: (mergedFrom.merge?.depth ?? 0) + 1,
      sourceAnchor,
      aliasAnchor,
    };
    if (mergeTrace.depth > this.options.maxMergeDepth) {
      throw new YamlGraphError(
        "MERGE_DEPTH",
        `Merge depth exceeded at ${mergePath}: ${mergeTrace.depth} > ${this.options.maxMergeDepth}`,
        {
          path: mergePath,
          actual: mergeTrace.depth,
          limit: this.options.maxMergeDepth,
        },
      );
    }
    return {
      kind: "merge",
      path: sourceEntry.origin.path,
      sourcePath: sourceEntry.origin.sourcePath,
      targetPath,
      mappingId: mapping.id,
      nodeId: sourceEntry.value.id,
      anchor: sourceAnchor ?? sourceEntry.value.anchor ?? sourceEntry.anchor,
      range: sourceEntry.value.range,
      keyRange: sourceEntry.key.range,
      merge: mergeTrace,
      mergedFrom,
      overridden: false,
    };
  }

  private enforceAliasBudget(): void {
    let total = 0;
    for (const alias of this.document.aliases) {
      const cost = this.expansionWeight(
        alias.target,
        new Set<YamlNode>(),
        this.options.maxAliasExpansions + 1,
        0,
        alias.path,
      );
      total += cost;
      if (total > this.options.maxAliasExpansions) {
        throw new YamlGraphError(
          "ALIAS_BUDGET",
          `Alias expansion budget exceeded at ${alias.path}: ${total} > ${this.options.maxAliasExpansions}`,
          {
            path: alias.path,
            range: alias.range,
            actual: total,
            limit: this.options.maxAliasExpansions,
            anchor: alias.anchor,
          },
        );
      }
    }
    this.aliasExpansionCost = total;
  }

  private expansionWeight(
    node: YamlNode,
    visiting: Set<YamlNode>,
    limit: number,
    depth: number,
    aliasPath: string,
  ): number {
    if (depth > this.options.maxAliasDepth) {
      throw new YamlGraphError(
        "ALIAS_DEPTH",
        `Alias expansion depth exceeded at ${aliasPath}: ${depth} > ${this.options.maxAliasDepth}`,
        {
          path: aliasPath,
          actual: depth,
          limit: this.options.maxAliasDepth,
        },
      );
    }
    if (node.kind === "scalar") return 1;
    const cached = this.weightCache.get(node);
    if (cached !== undefined) return cached;
    if (visiting.has(node)) return 1;
    visiting.add(node);
    let total = 1;
    if (node.kind === "sequence") {
      for (const item of node.items) {
        total += this.expansionWeight(item, visiting, limit, depth + 1, aliasPath);
        if (total > limit) break;
      }
    } else {
      for (const entry of node.entries) {
        total +=
          1 +
          this.expansionWeight(
            entry.value,
            visiting,
            limit,
            depth + 1,
            aliasPath,
          );
        if (total > limit) break;
      }
    }
    visiting.delete(node);
    const value = Math.min(total, limit);
    this.weightCache.set(node, value);
    return value;
  }
}

function cloneExplicit(
  raw: MappingEntry,
  provenance: EntryProvenance,
  targetPath: string,
): MappingEntry {
  const entry: MappingEntry = {
    key: raw.key,
    value: raw.value,
    keyText: raw.keyText,
    explicit: true,
    merged: false,
    fromMerge: false,
    sourceKind: "explicit",
    anchor: raw.value.anchor,
    sourceAnchor: provenance.anchor,
    targetPath,
    origin: provenance,
    provenance: [provenance],
    origins: [provenance],
    sources: [provenance],
    overridden: [],
    source: provenance,
  };
  entry.origin.targetPath = targetPath;
  return entry;
}

function cloneForMerge(
  source: MappingEntry,
  provenance: EntryProvenance,
  targetPath: string,
): MappingEntry {
  const entry: MappingEntry = {
    key: source.key,
    value: source.value,
    keyText: source.keyText,
    explicit: false,
    merged: true,
    fromMerge: true,
    sourceKind: "merge",
    anchor: provenance.anchor ?? source.anchor ?? source.value.anchor,
    sourceAnchor: provenance.anchor,
    targetPath,
    merge: provenance.merge,
    origin: provenance,
    provenance: [provenance],
    origins: [provenance],
    sources: [provenance],
    overridden: [],
    source: provenance,
    mergedFrom: provenance.mergedFrom,
  };
  provenance.targetPath = targetPath;
  return entry;
}

function applyMergeKeyStrategy(
  raw: MappingEntry[],
  _options: NormalizedBuildOptions,
  _path: string,
): MappingEntry[] {
  return raw;
}

function isMergeEntry(
  entry: MappingEntry,
  options: NormalizedBuildOptions,
): boolean {
  return (
    options.mergeKeys &&
    entry.key.kind === "scalar" &&
    entry.key.tag.endsWith(":merge") &&
    entry.key.raw === "<<"
  );
}

function pathForKey(base: string, key: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key)) return `${base}.${key}`;
  return `${base}[${JSON.stringify(key)}]`;
}
