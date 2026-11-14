import { YamlGraphError, YamlSyntaxError } from "./errors.ts";
import {
  TAGS,
  displayKey,
  normalizeTag,
  scalarNode,
} from "./scalar.ts";
import type {
  AliasCycle,
  AliasRecord,
  BuildOptions,
  EntryProvenance,
  MappingEntry,
  MappingNode,
  NormalizedBuildOptions,
  ScalarNode,
  ScalarStyle,
  SequenceNode,
  SourceRange,
  YamlDocument,
  YamlNode,
} from "./types.ts";

interface SourceLine {
  raw: string;
  text: string;
  content: string;
  indent: number;
  number: number;
  offset: number;
  endOffset: number;
}

interface NodeProperties {
  anchor?: string;
  tag?: string;
  end: number;
}

interface FragmentSegment {
  at: number;
  line: number;
  column: number;
  offset: number;
}

interface Fragment {
  text: string;
  segments: FragmentSegment[];
}

interface IdSource {
  next(): string;
}

export interface ParsedDocumentResult {
  document: YamlDocument;
  endLine: number;
  directives: string[];
}

const DEFAULT_OPTIONS: NormalizedBuildOptions = {
  duplicateKeys: "error",
  maxAliasExpansions: 10_000,
  maxAliasCount: 100_000,
  maxAliasDepth: 100,
  maxNodes: 100_000,
  maxDepth: 200,
  onAliasCycle: "error",
  mergeKeys: true,
  maxMergeDepth: 100,
  documentIndex: 0,
};

export function normalizeOptions(
  options: BuildOptions | null = {},
): NormalizedBuildOptions {
  options ??= {};
  const duplicate =
    options.duplicateKeys ??
    options.duplicateKey ??
    options.duplicateKeyStrategy ??
    options.duplicateKeyPolicy ??
    options.onDuplicateKey;
  let duplicateKeys: NormalizedBuildOptions["duplicateKeys"] = "error";
  if (duplicate === "first" || duplicate === "first-wins") duplicateKeys = "first";
  else if (duplicate === "last" || duplicate === "last-wins") duplicateKeys = "last";
  else if (duplicate === "error" || duplicate === "reject" || duplicate === undefined) {
    duplicateKeys = "error";
  } else {
    throw new YamlGraphError(
      "SYNTAX_ERROR",
      `Unknown duplicate key strategy: ${String(duplicate)}`,
    );
  }

  const onAliasCycle =
    options.allowCycles === true
      ? "allow"
      : options.onAliasCycle === "allow" ||
          options.onAliasCycle === "record" ||
          options.cyclePolicy === "allow" ||
          options.cyclePolicy === "record"
        ? "allow"
        : "error";

  return {
    duplicateKeys,
    maxAliasExpansions:
      options.maxAliasExpansions ??
      options.maxAliasCost ??
      options.maxAliasExpansionCost ??
      options.maxExpansionNodes ??
      options.maxAliasExpansion ??
      options.aliasExpansionLimit ??
      options.aliasBudget ??
      DEFAULT_OPTIONS.maxAliasExpansions,
    maxAliasCount: options.maxAliasCount ?? DEFAULT_OPTIONS.maxAliasCount,
    maxAliasDepth: options.maxAliasDepth ?? DEFAULT_OPTIONS.maxAliasDepth,
    maxNodes: options.maxNodes ?? DEFAULT_OPTIONS.maxNodes,
    maxDepth: options.maxDepth ?? DEFAULT_OPTIONS.maxDepth,
    onAliasCycle,
    mergeKeys:
      options.mergeKeys !== false &&
      options.enableMerge !== false &&
      options.merge !== false,
    maxMergeDepth: options.maxMergeDepth ?? DEFAULT_OPTIONS.maxMergeDepth,
    documentIndex: options.documentIndex ?? 0,
  };
}

export function createIdSource(): IdSource {
  let value = 0;
  return {
    next: () => `n${++value}`,
  };
}

export function splitSourceLines(source: string): SourceLine[] {
  const result: SourceLine[] = [];
  let offset = 0;
  let lineNumber = 1;
  while (offset <= source.length) {
    let newline = source.indexOf("\n", offset);
    let newlineLength = 1;
    if (newline < 0) {
      newline = source.indexOf("\r", offset);
      newlineLength = 1;
      if (newline < 0) newline = source.length;
    } else if (newline > offset && source[newline - 1] === "\r") {
      newline -= 1;
      newlineLength = 2;
    }
    const raw = source.slice(offset, newline);
    if (offset === source.length && raw === "" && result.length > 0) break;
    let indent = 0;
    while (indent < raw.length && raw[indent] === " ") indent += 1;
    if (indent < raw.length && raw[indent] === "\t") {
      throw new YamlSyntaxError(
        `Tabs may not be used for indentation at line ${lineNumber}, column ${indent + 1}`,
        {
          range: {
            start: { offset: offset + indent, line: lineNumber, column: indent + 1 },
            end: { offset: offset + indent + 1, line: lineNumber, column: indent + 2 },
          },
        },
      );
    }
    const body = raw.slice(indent);
    const content = stripComment(body).trimEnd();
    result.push({
      raw,
      text: body,
      content,
      indent,
      number: lineNumber,
      offset,
      endOffset: offset + raw.length,
    });
    if (newline >= source.length) break;
    offset = newline + newlineLength;
    lineNumber += 1;
  }
  return result;
}

function stripComment(text: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote === "'") {
      if (char === "'" && text[i + 1] === "'") {
        i += 1;
      } else if (char === "'") {
        quote = undefined;
      }
      continue;
    }
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(text[i - 1] ?? ""))) {
      return text.slice(0, i);
    }
  }
  return text;
}

function isSequenceIndicator(text: string): boolean {
  return text === "-" || text.startsWith("- ") || text.startsWith("-\t");
}

function isExplicitKeyIndicator(text: string): boolean {
  return text === "?" || text.startsWith("? ") || text.startsWith("?\t");
}

function findMappingColon(text: string): number {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote === "'") {
      if (char === "'" && text[i + 1] === "'") i += 1;
      else if (char === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (
      char === ":" &&
      depth === 0 &&
      (i + 1 === text.length || /\s/.test(text[i + 1] ?? ""))
    ) {
      return i;
    }
  }
  return -1;
}

function isDocumentStart(line: SourceLine): boolean {
  return (
    line.indent === 0 &&
    (line.content === "---" ||
      line.content.startsWith("--- ") ||
      line.content.startsWith("---\t"))
  );
}

function isDocumentEnd(line: SourceLine): boolean {
  return (
    line.indent === 0 &&
    (line.content === "..." ||
      line.content.startsWith("... ") ||
      line.content.startsWith("...\t"))
  );
}

function isDocumentMarker(line: SourceLine): boolean {
  return isDocumentStart(line) || isDocumentEnd(line);
}

function defaultNullNode(): ScalarNode {
  return scalarNode("", "plain", undefined);
}

function pathForKey(base: string, key: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key)) return `${base}.${key}`;
  return `${base}[${JSON.stringify(key)}]`;
}

function pathForIndex(base: string, index: number): string {
  return `${base}[${index}]`;
}

export class DocumentParser {
  readonly lines: SourceLine[];
  i: number;
  readonly source: string;
  readonly options: NormalizedBuildOptions;
  readonly ids: IdSource;
  readonly anchors = new Map<string, YamlNode>();
  readonly aliases: AliasRecord[] = [];
  readonly cycles: AliasCycle[] = [];
  readonly nodes: YamlNode[] = [];
  readonly directives: string[] = [];
  maxDepthSeen = 0;
  maxNodeCount = 0;

  private openNodes: YamlNode[] = [];
  private mergeDepth = 0;

  constructor(
    lines: SourceLine[],
    startIndex: number,
    source: string,
    options: NormalizedBuildOptions,
    ids: IdSource,
  ) {
    this.lines = lines;
    this.i = startIndex;
    this.source = source;
    this.options = options;
    this.ids = ids;
  }

  parse(): ParsedDocumentResult {
    this.skipBlankLines();
    while (this.i < this.lines.length) {
      const line = this.lines[this.i]!;
      if (line.indent === 0 && line.content.startsWith("%")) {
        this.directives.push(line.content);
        this.i += 1;
        this.skipBlankLines();
        continue;
      }
      break;
    }

    const startLine = this.i;
    if (this.i < this.lines.length && isDocumentStart(this.lines[this.i]!)) {
      const marker = this.lines[this.i]!;
      const tail = marker.content.slice(3).trimStart();
      if (tail.length > 0) {
        const startColumn = marker.indent + 4 + (marker.content.slice(3).length - tail.length);
        this.i += 1;
        const root = this.parseValueFromText(
          tail,
          marker,
          startColumn - 1,
          -1,
          "$",
          0,
          false,
        );
        return this.finishDocument(root, startLine);
      }
      this.i += 1;
      this.skipBlankLines();
    }

    if (
      this.i >= this.lines.length ||
      isDocumentStart(this.lines[this.i]!) ||
      isDocumentEnd(this.lines[this.i]!)
    ) {
      const root = this.createScalar(
        "",
        "plain",
        undefined,
        "$",
        this.emptyRangeAtCurrent(),
        0,
      );
      if (this.i < this.lines.length && isDocumentEnd(this.lines[this.i]!)) {
        this.i += 1;
      }
      return this.finishDocument(root, startLine);
    }

    const first = this.lines[this.i]!;
    const root = this.parseBlock(first.indent, "$", 0);
    this.skipBlankLines();
    if (
      this.i < this.lines.length &&
      !isDocumentStart(this.lines[this.i]!) &&
      !isDocumentEnd(this.lines[this.i]!)
    ) {
      const line = this.lines[this.i]!;
      throw new YamlSyntaxError(
        `Unexpected content at line ${line.number}, column ${line.indent + 1}`,
        { path: "$", range: this.lineRange(line) },
      );
    }
    if (this.i < this.lines.length && isDocumentEnd(this.lines[this.i]!)) {
      this.i += 1;
    }
    return this.finishDocument(root, startLine);
  }

  private finishDocument(root: YamlNode, startLine: number): ParsedDocumentResult {
    const start =
      startLine < this.lines.length
        ? this.positionFor(this.lines[startLine]!, 0)
        : { offset: this.source.length, line: this.lines.length || 1, column: 1 };
    const lastLine = this.lines[Math.max(0, Math.min(this.lines.length - 1, this.i - 1))];
    const end = lastLine
      ? this.positionFor(lastLine, lastLine.raw.length)
      : { offset: this.source.length, line: start.line, column: start.column };
    const aliases = this.aliases;
    const cycles = this.cycles;
    const nodes = this.nodes;
    const stats = {
      nodes: nodes.length,
      scalars: nodes.filter((node) => node.kind === "scalar").length,
      sequences: nodes.filter((node) => node.kind === "sequence").length,
      mappings: nodes.filter((node) => node.kind === "mapping").length,
      aliases: aliases.length,
      aliasExpansionCost: 0,
      maxDepth: this.maxDepthSeen,
    };
    const document: YamlDocument = {
      root,
      source: this.source,
      version: "1.2",
      anchors: this.anchors,
      aliases,
      cycles,
      nodes,
      stats,
      directives: this.directives,
      range: { start, end },
    };
    return { document, endLine: this.i, directives: this.directives };
  }

  parseBlock(
    indent: number,
    path: string,
    depth: number,
    properties?: NodeProperties,
  ): YamlNode {
    this.checkDepth(depth, path);
    const line = this.peekSignificant();
    if (!line || isDocumentMarker(line)) {
      const node = this.createScalar(
        "",
        "plain",
        properties?.tag,
        path,
        this.emptyRangeAtCurrent(),
        depth,
      );
      this.applyAnchor(node, properties?.anchor);
      return node;
    }
    if (line.indent < indent) {
      const node = this.createScalar(
        "",
        "plain",
        properties?.tag,
        path,
        this.lineRange(line),
        depth,
      );
      this.applyAnchor(node, properties?.anchor);
      return node;
    }
    const actualIndent = line.indent;
    const leadingProperties = this.readProperties(line.content, 0);
    if (
      (leadingProperties.anchor || leadingProperties.tag) &&
      leadingProperties.end > 0
    ) {
      const afterRaw = line.content.slice(leadingProperties.end);
      const after = afterRaw.trimStart();
      const afterColumn =
        actualIndent +
        leadingProperties.end +
        (afterRaw.length - after.length);
      if (after.length === 0) {
        this.i += 1;
        const next = this.peekSignificant();
        if (
          next &&
          !isDocumentMarker(next) &&
          next.indent >= actualIndent
        ) {
          return this.parseBlock(
            next.indent,
            path,
            depth,
            leadingProperties,
          );
        }
        const scalar = this.createScalar(
          "",
          "plain",
          leadingProperties.tag,
          path,
          this.lineRange(line),
          depth,
        );
        this.applyAnchor(scalar, leadingProperties.anchor);
        return scalar;
      }
      if (after.length > 0) {
        this.i += 1;
        if (isSequenceIndicator(after)) {
          return this.parseCompactSequence(
            after,
            line,
            afterColumn,
            actualIndent,
            path,
            depth,
            leadingProperties,
          );
        }
        if (
          isExplicitKeyIndicator(after) ||
          findMappingColon(after) >= 0
        ) {
          return this.parseCompactMapping(
            after,
            line,
            afterColumn,
            actualIndent,
            path,
            depth,
            leadingProperties,
          );
        }
        this.i -= 1;
      }
    }
    if (isSequenceIndicator(line.content)) {
      return this.parseBlockSequence(actualIndent, path, depth, properties);
    }
    if (
      isExplicitKeyIndicator(line.content) ||
      findMappingColon(line.content) >= 0
    ) {
      return this.parseBlockMapping(actualIndent, path, depth, properties);
    }
    this.i += 1;
    return this.parseValueFromText(
      line.content,
      line,
      line.indent,
      indent,
      path,
      depth,
      false,
      properties,
    );
  }

  private parseBlockMapping(
    indent: number,
    path: string,
    depth: number,
    properties?: NodeProperties,
  ): MappingNode {
    const startLine = this.peekSignificant();
    const node = this.createMapping(
      path,
      startLine ? this.lineRange(startLine) : this.emptyRangeAtCurrent(),
      depth,
      properties,
    );
    this.beginOpen(node);
    const entries: MappingEntry[] = [];
    while (this.i < this.lines.length) {
      this.skipBlankLines();
      const line = this.i < this.lines.length ? this.lines[this.i]! : undefined;
      if (!line || isDocumentMarker(line)) break;
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new YamlSyntaxError(
          `Unexpected indentation at line ${line.number}, column ${line.indent + 1}; expected ${indent + 1}`,
          { path, range: this.lineRange(line) },
        );
      }
      if (isSequenceIndicator(line.content)) break;
      if (isExplicitKeyIndicator(line.content)) {
        entries.push(this.parseExplicitMappingEntry(line, indent, path, depth));
        continue;
      }
      const colon = findMappingColon(line.content);
      if (colon < 0) {
        throw new YamlSyntaxError(
          `Expected a mapping entry at line ${line.number}, column ${indent + 1}`,
          { path, range: this.lineRange(line) },
        );
      }
      entries.push(this.parseMappingLineEntry(line, colon, indent, path, depth));
    }
    node.entries = entries;
    node.rawEntries = entries.slice();
    if (startLine) {
      const endLine = lineAt(this.lines, this.i - 1);
      node.range.end = this.positionFor(endLine, endLine.raw.length);
    }
    this.endOpen(node);
    return node;
  }

  private parseMappingLineEntry(
    line: SourceLine,
    colon: number,
    indent: number,
    path: string,
    depth: number,
  ): MappingEntry {
    const keyTextRaw = line.content.slice(0, colon).trim();
    if (keyTextRaw.length === 0) {
      throw new YamlSyntaxError(
        `Empty mapping key at line ${line.number}, column ${indent + 1}`,
        { path, range: this.lineRange(line) },
      );
    }
    const keyColumn = line.content.indexOf(keyTextRaw);
    const key = this.parseKey(
      keyTextRaw,
      line,
      indent + keyColumn,
      path,
      depth,
    );
    const keyText = displayKey(key);
    const valuePath = pathForKey(path, keyText);
    const rawAfterColon = line.content.slice(colon + 1);
    const leading = rawAfterColon.length - rawAfterColon.trimStart().length;
    const rest = rawAfterColon.trimStart();
    const restColumn = indent + colon + 1 + leading;
    this.i += 1;

    let value: YamlNode;
    if (rest.length === 0) {
      value = this.parseBlockValueAfterKey(indent, valuePath, depth, line, colon);
    } else {
      value = this.parseValueFromText(
        rest,
        line,
        restColumn,
        indent,
        valuePath,
        depth,
        true,
      );
    }
    return this.makeRawEntry(key, value, keyText, valuePath, line);
  }

  private parseExplicitMappingEntry(
    line: SourceLine,
    indent: number,
    path: string,
    depth: number,
  ): MappingEntry {
    const tail = line.content.slice(1).trimStart();
    const keyColumn = indent + (line.content.length - tail.length);
    this.i += 1;
    let key: YamlNode;
    if (tail.length === 0) {
      const next = this.peekSignificant();
      if (next && !isDocumentMarker(next) && next.indent > indent) {
        key = this.parseBlock(next.indent, path, depth + 1);
      } else {
        key = this.createScalar("", "plain", undefined, path, this.lineRange(line), depth + 1);
      }
    } else {
      key = this.parseKey(tail, line, keyColumn, path, depth + 1);
    }

    const keyText = displayKey(key);
    let valuePath = pathForKey(path, keyText);
    this.skipBlankLines();
    const valueLine = this.i < this.lines.length ? this.lines[this.i]! : undefined;
    let value: YamlNode;
    if (
      valueLine &&
      !isDocumentMarker(valueLine) &&
      valueLine.indent === indent &&
      (valueLine.content === ":" ||
        valueLine.content.startsWith(": ") ||
        valueLine.content.startsWith(":\t"))
    ) {
      const rest = valueLine.content.slice(1).trimStart();
      const restColumn = indent + valueLine.content.length - rest.length;
      this.i += 1;
      if (rest.length === 0) {
        value = this.parseBlockValueAfterKey(
          indent,
          valuePath,
          depth + 1,
          valueLine,
          0,
        );
      } else {
        value = this.parseValueFromText(
          rest,
          valueLine,
          restColumn,
          indent,
          valuePath,
          depth + 1,
          true,
        );
      }
    } else if (valueLine && !isDocumentMarker(valueLine) && valueLine.indent > indent) {
      value = this.parseBlock(valueLine.indent, valuePath, depth + 1);
    } else {
      value = this.createScalar(
        "",
        "plain",
        undefined,
        valuePath,
        this.lineRange(line),
        depth + 1,
      );
    }
    return this.makeRawEntry(key, value, keyText, valuePath, line);
  }

  private parseBlockValueAfterKey(
    indent: number,
    path: string,
    depth: number,
    previousLine: SourceLine,
    colon: number,
  ): YamlNode {
    const next = this.peekSignificant();
    if (next && !isDocumentMarker(next)) {
      if (next.indent > indent) {
        return this.parseBlock(next.indent, path, depth + 1);
      }
      if (next.indent === indent && isSequenceIndicator(next.content)) {
        return this.parseBlockSequence(next.indent, path, depth + 1);
      }
    }
    const column = indent + colon + 2;
    return this.createScalar(
      "",
      "plain",
      undefined,
      path,
      {
        start: this.positionFor(previousLine, column - 1),
        end: this.positionFor(previousLine, column - 1),
      },
      depth + 1,
    );
  }

  private parseBlockSequence(
    indent: number,
    path: string,
    depth: number,
    properties?: NodeProperties,
  ): SequenceNode {
    const startLine = this.peekSignificant();
    const node = this.createSequence(
      path,
      startLine ? this.lineRange(startLine) : this.emptyRangeAtCurrent(),
      depth,
      properties,
    );
    this.beginOpen(node);
    let index = 0;
    while (this.i < this.lines.length) {
      this.skipBlankLines();
      const line = this.i < this.lines.length ? this.lines[this.i]! : undefined;
      if (!line || isDocumentMarker(line)) break;
      if (line.indent !== indent || !isSequenceIndicator(line.content)) break;
      index += 1;
      const itemPath = pathForIndex(path, index - 1);
      const dashTail = line.content.slice(1);
      const rest = dashTail.trimStart();
      const restColumn = indent + 1 + (dashTail.length - rest.length);
      this.i += 1;

      if (rest.length === 0) {
        const next = this.peekSignificant();
        if (next && !isDocumentMarker(next) && next.indent > indent) {
          node.items.push(this.parseBlock(next.indent, itemPath, depth + 1));
        } else {
          node.items.push(
            this.createScalar(
              "",
              "plain",
              undefined,
              itemPath,
              this.lineRange(line),
              depth + 1,
            ),
          );
        }
        continue;
      }

      const properties = this.readProperties(rest, 0);
      const afterProperties = rest.slice(properties.end).trimStart();
      const afterPropertiesColumn =
        restColumn + properties.end + (rest.slice(properties.end).length - afterProperties.length);
      const compactIndent = restColumn;
      if (afterProperties.length === 0) {
        const next = this.peekSignificant();
        if (next && !isDocumentMarker(next) && next.indent > indent) {
          node.items.push(
            this.parseBlock(next.indent, itemPath, depth + 1, properties),
          );
        } else {
          const scalar = this.createScalar(
            "",
            "plain",
            properties.tag,
            itemPath,
            this.lineRange(line),
            depth + 1,
          );
          this.applyAnchor(scalar, properties.anchor);
          node.items.push(scalar);
        }
      } else if (isSequenceIndicator(afterProperties)) {
        node.items.push(
          this.parseCompactSequence(
            afterProperties,
            line,
            afterPropertiesColumn,
            compactIndent,
            itemPath,
            depth + 1,
            properties,
          ),
        );
      } else if (
        isExplicitKeyIndicator(afterProperties) ||
        findMappingColon(afterProperties) >= 0
      ) {
        node.items.push(
          this.parseCompactMapping(
            afterProperties,
            line,
            afterPropertiesColumn,
            compactIndent,
            itemPath,
            depth + 1,
            properties,
          ),
        );
      } else {
        node.items.push(
          this.parseValueFromText(
            afterProperties,
            line,
            afterPropertiesColumn,
            indent,
            itemPath,
            depth + 1,
            false,
            properties,
          ),
        );
      }
    }
    const sequenceEndLine = lineAt(this.lines, this.i - 1);
    node.range.end = this.positionFor(sequenceEndLine, sequenceEndLine.raw.length);
    this.endOpen(node);
    return node;
  }

  private parseCompactMapping(
    firstText: string,
    line: SourceLine,
    firstColumn: number,
    indent: number,
    path: string,
    depth: number,
    properties?: NodeProperties,
  ): MappingNode {
    const node = this.createMapping(
      path,
      this.rangeForText(line, firstColumn, firstColumn + firstText.length),
      depth,
      properties,
    );
    this.beginOpen(node);
    const firstColon = findMappingColon(firstText);
    if (isExplicitKeyIndicator(firstText)) {
      throw new YamlSyntaxError(
        `Explicit keys are not supported in compact sequence mappings at line ${line.number}`,
        { path, range: this.lineRange(line) },
      );
    }
    if (firstColon < 0) {
      throw new YamlSyntaxError(
        `Expected a compact mapping entry at line ${line.number}, column ${firstColumn + 1}`,
        { path, range: this.lineRange(line) },
      );
    }
    const keyTextRaw = firstText.slice(0, firstColon).trim();
    const keyColumn = firstColumn + firstText.indexOf(keyTextRaw);
    const key = this.parseKey(keyTextRaw, line, keyColumn, path, depth + 1);
    const keyText = displayKey(key);
    const valuePath = pathForKey(path, keyText);
    const rawAfterColon = firstText.slice(firstColon + 1);
    const rest = rawAfterColon.trimStart();
    const restColumn = firstColumn + firstColon + 1 + (rawAfterColon.length - rest.length);
    let value: YamlNode;
    if (rest.length === 0) {
      value = this.parseBlockValueAfterKey(
        indent,
        valuePath,
        depth + 1,
        line,
        firstColon,
      );
    } else {
      value = this.parseValueFromText(
        rest,
        line,
        restColumn,
        indent,
        valuePath,
        depth + 1,
        true,
      );
    }
    node.entries.push(this.makeRawEntry(key, value, keyText, valuePath, line));

    while (this.i < this.lines.length) {
      this.skipBlankLines();
      const next = this.i < this.lines.length ? this.lines[this.i]! : undefined;
      if (!next || isDocumentMarker(next)) break;
      if (next.indent !== indent || isSequenceIndicator(next.content)) break;
      if (isExplicitKeyIndicator(next.content)) {
        node.entries.push(this.parseExplicitMappingEntry(next, indent, path, depth + 1));
        continue;
      }
      const colon = findMappingColon(next.content);
      if (colon < 0) {
        throw new YamlSyntaxError(
          `Expected a compact mapping entry at line ${next.number}, column ${indent + 1}`,
          { path, range: this.lineRange(next) },
        );
      }
      node.entries.push(this.parseMappingLineEntry(next, colon, indent, path, depth + 1));
    }
    node.rawEntries = node.entries.slice();
    const compactMappingEndLine = lineAt(this.lines, this.i - 1);
    node.range.end = this.positionFor(
      compactMappingEndLine,
      compactMappingEndLine.raw.length,
    );
    this.endOpen(node);
    return node;
  }

  private parseCompactSequence(
    firstText: string,
    line: SourceLine,
    firstColumn: number,
    indent: number,
    path: string,
    depth: number,
    properties?: NodeProperties,
  ): SequenceNode {
    const node = this.createSequence(
      path,
      this.rangeForText(line, firstColumn, firstColumn + firstText.length),
      depth,
      properties,
    );
    this.beginOpen(node);
    let index = 0;
    let text = firstText;
    let textLine = line;
    let textColumn = firstColumn;
    while (true) {
      const dashTail = text.slice(1);
      const rest = dashTail.trimStart();
      const restColumn = textColumn + 1 + (dashTail.length - rest.length);
      const itemPath = pathForIndex(path, index);
      index += 1;
      if (rest.length === 0) {
        const next = this.peekSignificant();
        if (next && !isDocumentMarker(next) && next.indent > indent) {
          node.items.push(this.parseBlock(next.indent, itemPath, depth + 1));
        } else {
          node.items.push(
            this.createScalar(
              "",
              "plain",
              undefined,
              itemPath,
              this.lineRange(textLine),
              depth + 1,
            ),
          );
        }
      } else {
        const props = this.readProperties(rest, 0);
        const after = rest.slice(props.end).trimStart();
        const afterColumn =
          restColumn + props.end + (rest.slice(props.end).length - after.length);
        if (after.length > 0 && isSequenceIndicator(after)) {
          node.items.push(
            this.parseCompactSequence(
              after,
              textLine,
              afterColumn,
              indent,
              itemPath,
              depth + 1,
              props,
            ),
          );
        } else if (
          after.length > 0 &&
          (isExplicitKeyIndicator(after) || findMappingColon(after) >= 0)
        ) {
          node.items.push(
            this.parseCompactMapping(
              after,
              textLine,
              afterColumn,
              indent,
              itemPath,
              depth + 1,
              props,
            ),
          );
        } else {
          node.items.push(
            this.parseValueFromText(
              after.length > 0 ? after : rest,
              textLine,
              after.length > 0 ? afterColumn : restColumn,
              indent,
              itemPath,
              depth + 1,
              false,
              props,
            ),
          );
        }
      }
      this.skipBlankLines();
      const next = this.i < this.lines.length ? this.lines[this.i]! : undefined;
      if (
        !next ||
        isDocumentMarker(next) ||
        next.indent !== indent ||
        !isSequenceIndicator(next.content)
      ) {
        break;
      }
      textLine = next;
      text = next.content;
      textColumn = indent;
      this.i += 1;
    }
    const compactSequenceEndLine = lineAt(this.lines, this.i - 1);
    node.range.end = this.positionFor(
      compactSequenceEndLine,
      compactSequenceEndLine.raw.length,
    );
    this.endOpen(node);
    return node;
  }

  parseValueFromText(
    text: string,
    line: SourceLine,
    baseColumn: number,
    parentIndent: number,
    path: string,
    depth: number,
    allowBlock: boolean,
    overrideProperties?: NodeProperties,
  ): YamlNode {
    this.checkDepth(depth, path);
    const properties = overrideProperties
      ? { ...overrideProperties, end: 0 }
      : this.readProperties(text, 0);
    let restIndex = properties.end;
    while (restIndex < text.length && /\s/.test(text[restIndex] ?? "")) restIndex += 1;
    const rest = text.slice(restIndex).trimEnd();

    if (rest.length === 0) {
      if (allowBlock) {
        const next = this.peekSignificant();
        if (next && !isDocumentMarker(next)) {
          if (next.indent > parentIndent) {
            return this.parseBlock(next.indent, path, depth + 1, properties);
          }
          if (next.indent === parentIndent && isSequenceIndicator(next.content)) {
            return this.parseBlockSequence(next.indent, path, depth + 1, properties);
          }
        }
      }
      const scalar = this.createScalar(
        "",
        "plain",
        properties.tag,
        path,
        this.rangeForText(line, baseColumn + restIndex, baseColumn + text.length),
        depth,
      );
      this.applyAnchor(scalar, properties.anchor);
      return scalar;
    }

    const first = rest[0]!;
    if (first === "*") {
      if (properties.anchor || properties.tag) {
        throw new YamlSyntaxError(
          `An alias cannot have node properties at line ${line.number}, column ${baseColumn + 1}`,
          { path, range: this.rangeForText(line, baseColumn, baseColumn + text.length) },
        );
      }
      return this.parseAlias(rest, line, baseColumn + restIndex, path, depth);
    }
    if (first === "[") {
      return this.parseFlow(rest, line, baseColumn + restIndex, path, depth, properties);
    }
    if (first === "{") {
      return this.parseFlow(rest, line, baseColumn + restIndex, path, depth, properties);
    }
    if (first === "|" || first === ">") {
      return this.parseBlockScalar(rest, line, parentIndent, path, depth, properties);
    }
    if (first === "'" || first === '"') {
      return this.parseQuoted(rest, line, restIndex, path, depth, properties);
    }

    const initialRange = this.rangeForText(
      line,
      baseColumn + restIndex,
      baseColumn + text.length,
    );
    const continuation = this.collectPlainContinuation(rest, parentIndent);
    return this.createScalar(
      continuation.value,
      "plain",
      properties.tag,
      path,
      {
        start: initialRange.start,
        end: continuation.end ?? initialRange.end,
      },
      depth,
      properties.anchor,
    );
  }

  private collectPlainContinuation(
    initial: string,
    parentIndent: number,
  ): { value: string; end?: ReturnType<DocumentParser["positionFor"]> } {
    let value = initial;
    let lastLine: SourceLine | undefined;
    let blankLines = 0;
    while (this.i < this.lines.length) {
      const next = this.lines[this.i]!;
      if (isDocumentMarker(next)) break;
      if (next.content.trim().length === 0) {
        blankLines += 1;
        this.i += 1;
        continue;
      }
      if (next.indent <= parentIndent) break;
      if (blankLines > 0) value += "\n".repeat(blankLines);
      else value += " ";
      value += next.content.trim();
      blankLines = 0;
      lastLine = next;
      this.i += 1;
    }
    return {
      value,
      end: lastLine ? this.positionFor(lastLine, lastLine.raw.length) : undefined,
    };
  }

  readProperties(text: string, startIndex = 0): NodeProperties {
    let index = startIndex;
    let anchor: string | undefined;
    let tag: string | undefined;
    while (index < text.length) {
      while (index < text.length && /\s/.test(text[index] ?? "")) index += 1;
      const char = text[index];
      if (char === "&") {
        const begin = ++index;
        while (
          index < text.length &&
          !/[\s,[\]{}]/.test(text[index] ?? "")
        ) {
          index += 1;
        }
        if (index === begin) {
          throw new YamlSyntaxError("An anchor name is required after '&'");
        }
        anchor = text.slice(begin, index);
        continue;
      }
      if (char === "!") {
        const begin = index;
        if (text[index + 1] === "<") {
          const close = text.indexOf(">", index + 2);
          if (close < 0) {
            throw new YamlSyntaxError("Unterminated verbatim tag");
          }
          index = close + 1;
        } else {
          index += 1;
          while (
            index < text.length &&
            !/[\s,[\]{}]/.test(text[index] ?? "")
          ) {
            index += 1;
          }
        }
        tag = text.slice(begin, index);
        continue;
      }
      break;
    }
    return { anchor, tag, end: index };
  }

  parseKey(
    text: string,
    line: SourceLine,
    column: number,
    path: string,
    depth: number,
  ): YamlNode {
    const properties = this.readProperties(text, 0);
    let index = properties.end;
    while (index < text.length && /\s/.test(text[index] ?? "")) index += 1;
    const rest = text.slice(index).trimEnd();
    if (rest.startsWith("*")) {
      return this.parseAlias(rest, line, column + index, path, depth);
    }
    if (rest.startsWith("[") || rest.startsWith("{")) {
      return this.parseFlow(rest, line, column + index, path, depth, properties);
    }
    if (rest.startsWith("'") || rest.startsWith('"')) {
      return this.parseQuoted(rest, line, column + index, path, depth, properties);
    }
    const key = this.createScalar(
      rest,
      "plain",
      properties.tag,
      path,
      this.rangeForText(line, column + index, column + text.length),
      depth,
      properties.anchor,
    );
    return key;
  }

  parseAlias(
    text: string,
    line: SourceLine,
    column: number,
    path: string,
    depth: number,
  ): YamlNode {
    let end = 1;
    while (end < text.length && !/[\s,[\]{}]/.test(text[end] ?? "")) end += 1;
    const anchor = text.slice(1, end);
    if (anchor.length === 0) {
      throw new YamlSyntaxError(
        `An alias name is required at line ${line.number}, column ${column + 1}`,
        { path, range: this.rangeForText(line, column, column + 1) },
      );
    }
    const range = this.rangeForText(line, column, column + end);
    return this.parseAliasReference(anchor, path, range, depth);
  }

  private makeCycle(anchor: string, path: string, target: YamlNode): AliasCycle {
    return {
      anchor,
      path,
      targetPath: target.path,
      pathSegments: [...splitPath(target.path), `*${anchor}`],
      message: `Alias cycle: ${path} -> ${target.path} (*${anchor})`,
    };
  }

  private checkAliasCount(path: string, range: SourceRange): void {
    if (this.aliases.length > this.options.maxAliasCount) {
      throw new YamlGraphError(
        "ALIAS_COUNT",
        `Alias count budget exceeded at ${path}: ${this.aliases.length} > ${this.options.maxAliasCount}`,
        {
          path,
          range,
          actual: this.aliases.length,
          limit: this.options.maxAliasCount,
        },
      );
    }
  }

  parseFlow(
    text: string,
    line: SourceLine,
    column: number,
    path: string,
    depth: number,
    properties?: NodeProperties,
  ): YamlNode {
    const fragment = this.collectFragment(text, line, column, "flow");
    const parser = new FlowParser(this, fragment, path, depth + 1, properties);
    return parser.parse();
  }

  parseQuoted(
    text: string,
    line: SourceLine,
    column: number,
    path: string,
    depth: number,
    properties?: NodeProperties,
  ): ScalarNode {
    const fragment = this.collectFragment(text, line, column, "quoted");
    const quote = fragment.text[0];
    const end = findClosingQuote(fragment.text, quote);
    if (end < 0) {
      const position = this.positionInFragment(fragment, fragment.text.length);
      throw new YamlSyntaxError(
        `Unterminated quoted scalar at line ${position.line}, column ${position.column}`,
        {
          path,
          range: {
            start: this.positionInFragment(fragment, 0),
            end: position,
          },
        },
      );
    }
    const inner = fragment.text.slice(1, end);
    const raw =
      quote === "'" ? inner.replace(/''/g, "'") : decodeDoubleQuoted(inner);
    const endPosition = this.positionInFragment(fragment, end + 1);
    const startPosition = this.positionInFragment(fragment, 0);
    return this.createScalar(
      raw,
      quote === "'" ? "single-quoted" : "double-quoted",
      properties?.tag,
      path,
      { start: startPosition, end: endPosition },
      depth,
      properties?.anchor,
    );
  }

  parseBlockScalar(
    header: string,
    line: SourceLine,
    parentIndent: number,
    path: string,
    depth: number,
    properties?: NodeProperties,
  ): ScalarNode {
    const style: ScalarStyle = header[0] === "|" ? "literal" : "folded";
    let chomp: "clip" | "strip" | "keep" = "clip";
    let indicator: number | undefined;
    for (let i = 1; i < header.length; i += 1) {
      const char = header[i]!;
      if (char === "-") chomp = "strip";
      else if (char === "+") chomp = "keep";
      else if (/[1-9]/.test(char)) indicator = Number(char);
      else if (/\s/.test(char)) break;
      else {
        throw new YamlSyntaxError(
          `Invalid block scalar header at line ${line.number}, column ${line.indent + 1}`,
          { path, range: this.lineRange(line) },
        );
      }
    }

    const firstContentLine = this.peekSignificant();
    let contentIndent: number;
    if (indicator !== undefined) {
      contentIndent = Math.max(0, parentIndent) + indicator;
    } else if (firstContentLine) {
      contentIndent = firstContentLine.indent;
      if (contentIndent <= parentIndent) contentIndent = parentIndent + 1;
    } else {
      contentIndent = Math.max(0, parentIndent + 1);
    }

    const rawLines: string[] = [];
    while (this.i < this.lines.length) {
      const current = this.lines[this.i]!;
      if (isDocumentMarker(current)) break;
      if (current.content.trim().length === 0) {
        rawLines.push("");
        this.i += 1;
        continue;
      }
      if (current.indent < contentIndent) break;
      rawLines.push(current.raw.slice(contentIndent));
      this.i += 1;
    }

    while (rawLines.length > 0 && rawLines[rawLines.length - 1] === "" && chomp !== "keep") {
      rawLines.pop();
    }
    let value = style === "literal" ? rawLines.join("\n") : foldBlockLines(rawLines);
    if (chomp === "clip" && value.length > 0 && !value.endsWith("\n")) value += "\n";
    if (chomp === "keep") {
      value += "\n";
    }
    const endLine = lineAt(this.lines, this.i - 1);
    return this.createScalar(
      value,
      style,
      properties?.tag,
      path,
      {
        start: this.positionFor(line, line.indent),
        end: this.positionFor(endLine, endLine.raw.length),
      },
      depth,
      properties?.anchor,
    );
  }

  private collectFragment(
    text: string,
    line: SourceLine,
    column: number,
    mode: "flow" | "quoted",
  ): Fragment {
    const segments: FragmentSegment[] = [
      {
        at: 0,
        line: line.number,
        column: column + 1,
        offset: line.offset + column,
      },
    ];
    let result = text;
    let complete = mode === "flow" ? flowIsComplete(result) : findClosingQuote(result, result[0]) >= 0;
    while (!complete && this.i < this.lines.length) {
      const next = this.lines[this.i]!;
      if (isDocumentMarker(next)) break;
      result += `\n${next.content}`;
      segments.push({
        at: result.length - next.content.length,
        line: next.number,
        column: next.indent + 1,
        offset: next.offset + next.indent,
      });
      this.i += 1;
      complete =
        mode === "flow" ? flowIsComplete(result) : findClosingQuote(result, result[0]) >= 0;
    }
    return { text: result, segments };
  }

  positionInFragment(fragment: Fragment, index: number) {
    let segment = fragment.segments[0]!;
    for (const candidate of fragment.segments) {
      if (candidate.at > index) break;
      segment = candidate;
    }
    const delta = index - segment.at;
    return {
      offset: segment.offset + delta,
      line: segment.line,
      column: segment.column + delta,
    };
  }

  rangeInFragment(fragment: Fragment, start: number, end: number): SourceRange {
    return {
      start: this.positionInFragment(fragment, start),
      end: this.positionInFragment(fragment, end),
    };
  }

  skipBlankLines(): void {
    while (this.i < this.lines.length) {
      const line = this.lines[this.i]!;
      if (line.content.trim().length === 0) this.i += 1;
      else break;
    }
  }

  peekSignificant(start = this.i): SourceLine | undefined {
    let index = start;
    while (index < this.lines.length) {
      const line = this.lines[index]!;
      if (line.content.trim().length === 0) {
        index += 1;
        continue;
      }
      return line;
    }
    return undefined;
  }

  createScalar(
    raw: string,
    style: ScalarStyle,
    explicitTag: string | undefined,
    path: string,
    range: SourceRange,
    depth: number,
    anchor?: string,
  ): ScalarNode {
    this.checkDepth(depth, path);
    const node = scalarNode(raw, style, explicitTag);
    (node as { id: string }).id = this.allocateId();
    node.path = path;
    node.range = range;
    this.applyAnchor(node, anchor);
    this.nodes.push(node);
    return node;
  }

  createMapping(
    path: string,
    range: SourceRange,
    depth: number,
    properties?: NodeProperties,
  ): MappingNode {
    this.checkDepth(depth, path);
    const tag = normalizeTag(properties?.tag) ?? TAGS.map;
    const node = {
      id: this.allocateId(),
      kind: "mapping",
      type: "mapping",
      tag,
      explicitTag: properties?.tag,
      path,
      range,
      entries: [],
      rawEntries: [],
      provenance: new Map<string, EntryProvenance[]>(),
      get(this: MappingNode, key: string): YamlNode | undefined {
        return this.getEntry(key)?.value;
      },
      getEntry(this: MappingNode, key: string): MappingEntry | undefined {
        return this.entries.find((entry) => {
          if (entry.key.kind !== "scalar") return false;
          return (
            entry.key.raw === key ||
            String(entry.key.value) === key ||
            entry.keyText === key
          );
        });
      },
      provenanceFor(this: MappingNode, key: string): EntryProvenance[] {
        return this.getEntry(key)?.provenance ?? [];
      },
      trace(this: MappingNode, key: string): EntryProvenance[] {
        return this.provenanceFor(key);
      },
    } as MappingNode;
    this.applyAnchor(node, properties?.anchor);
    this.nodes.push(node);
    return node;
  }

  createSequence(
    path: string,
    range: SourceRange,
    depth: number,
    properties?: NodeProperties,
  ): SequenceNode {
    this.checkDepth(depth, path);
    const node: SequenceNode = {
      id: this.allocateId(),
      kind: "sequence",
      type: "sequence",
      tag: normalizeTag(properties?.tag) ?? TAGS.seq,
      explicitTag: properties?.tag,
      path,
      range,
      items: [],
    };
    this.applyAnchor(node, properties?.anchor);
    this.nodes.push(node);
    return node;
  }

  applyAnchor(node: YamlNode, anchor?: string): void {
    if (!anchor) return;
    node.anchor = anchor;
    this.anchors.set(anchor, node);
  }

  beginOpen(node: YamlNode): void {
    this.openNodes.push(node);
  }

  endOpen(node: YamlNode): void {
    const index = this.openNodes.lastIndexOf(node);
    if (index >= 0) this.openNodes.splice(index, 1);
  }

  makeRawEntry(
    key: YamlNode,
    value: YamlNode,
    keyText: string,
    path: string,
    line?: SourceLine,
  ): MappingEntry {
    const kind = isMergeKey(key, this.options.mergeKeys) ? "merge" : "explicit";
    const provenance: EntryProvenance = {
      kind,
      path,
      sourcePath: path,
      targetPath: path,
      mappingId: "",
      nodeId: value.id,
      anchor: value.anchor,
      range: value.range,
      keyRange: key.range,
      overridden: false,
    };
    const entry: MappingEntry = {
      key,
      value,
      keyText,
      explicit: kind === "explicit",
      merged: false,
      fromMerge: false,
      sourceKind: kind,
      anchor: value.anchor,
      sourceAnchor: undefined,
      targetPath: path,
      origin: provenance,
      provenance: [provenance],
      origins: [provenance],
      sources: [provenance],
      overridden: [],
      source: provenance,
    };
    if (line) entry.anchor = value.anchor;
    return entry;
  }

  parseAliasReference(
    anchor: string,
    path: string,
    range: SourceRange,
    depth: number,
  ): YamlNode {
    this.checkDepth(depth, path);
    const target = this.anchors.get(anchor);
    if (!target) {
      throw new YamlGraphError(
        "UNKNOWN_ANCHOR",
        `Unknown alias '*${anchor}' at ${path}`,
        { path, anchor, range },
      );
    }
    const record: AliasRecord = {
      anchor,
      path,
      target,
      targetPath: target.path,
      range,
    };
    if (this.openNodes.includes(target)) {
      const cycle = this.makeCycle(anchor, path, target);
      record.cycle = cycle;
      this.cycles.push(cycle);
      if (this.options.onAliasCycle === "error") {
        throw new YamlGraphError(
          "ALIAS_CYCLE",
          `Alias cycle detected at ${path}: ${cycle.message}`,
          { path, anchor, range, cycle },
        );
      }
    }
    this.aliases.push(record);
    this.checkAliasCount(path, range);
    return target;
  }

  checkDepth(depth: number, path: string): void {
    this.maxDepthSeen = Math.max(this.maxDepthSeen, depth);
    if (depth > this.options.maxDepth) {
      throw new YamlGraphError(
        "MAX_DEPTH",
        `Maximum graph depth exceeded at ${path}: ${depth} > ${this.options.maxDepth}`,
        { path, actual: depth, limit: this.options.maxDepth },
      );
    }
  }

  private allocateId(): string {
    const id = this.ids.next();
    if (this.nodes.length + 1 > this.options.maxNodes) {
      throw new YamlGraphError(
        "MAX_NODES",
        `Node budget exceeded: ${this.nodes.length + 1} > ${this.options.maxNodes}`,
        { actual: this.nodes.length + 1, limit: this.options.maxNodes },
      );
    }
    return id;
  }

  positionFor(line: SourceLine, columnIndex: number) {
    const safeColumn = Math.max(0, Math.min(line.raw.length, columnIndex));
    return {
      offset: line.offset + safeColumn,
      line: line.number,
      column: safeColumn + 1,
    };
  }

  lineRange(line: SourceLine): SourceRange {
    return {
      start: this.positionFor(line, line.indent),
      end: this.positionFor(line, line.raw.length),
    };
  }

  rangeForText(line: SourceLine, startColumn: number, endColumn: number): SourceRange {
    return {
      start: this.positionFor(line, startColumn),
      end: this.positionFor(line, endColumn),
    };
  }

  emptyRangeAtCurrent(): SourceRange {
    if (this.i < this.lines.length) {
      return {
        start: this.positionFor(this.lines[this.i]!, this.lines[this.i]!.indent),
        end: this.positionFor(this.lines[this.i]!, this.lines[this.i]!.indent),
      };
    }
    const line = this.lines.length || 1;
    const offset = this.source.length;
    return {
      start: { offset, line, column: 1 },
      end: { offset, line, column: 1 },
    };
  }

  locationSuffix(line?: SourceLine): string {
    return line ? ` at line ${line.number}, column ${line.indent + 1}` : "";
  }
}

class FlowParser {
  private index = 0;
  private readonly owner: DocumentParser;
  private readonly fragment: Fragment;
  private readonly path: string;
  private readonly depth: number;
  private readonly rootProperties?: NodeProperties;

  constructor(
    owner: DocumentParser,
    fragment: Fragment,
    path: string,
    depth: number,
    rootProperties?: NodeProperties,
  ) {
    this.owner = owner;
    this.fragment = fragment;
    this.path = path;
    this.depth = depth;
    this.rootProperties = rootProperties;
  }

  parse(): YamlNode {
    this.skipWhitespace();
    const node = this.parseNode(this.path, false, this.rootProperties);
    this.skipWhitespace();
    if (this.index < this.fragment.text.length) {
      const position = this.owner.positionInFragment(this.fragment, this.index);
      throw new YamlSyntaxError(
        `Unexpected content after flow value at line ${position.line}, column ${position.column}`,
        {
          path: this.path,
          range: {
            start: position,
            end: this.owner.positionInFragment(this.fragment, this.fragment.text.length),
          },
        },
      );
    }
    return node;
  }

  private parseNode(
    path: string,
    stopAtColon: boolean,
    inheritedProperties?: NodeProperties,
  ): YamlNode {
    this.skipWhitespace();
    let properties = inheritedProperties;
    if (!properties) {
      properties = this.owner.readProperties(this.fragment.text, this.index);
      this.index = properties.end;
      this.skipWhitespace();
    }
    const start = this.index;
    const char = this.fragment.text[start];
    if (char === "[") {
      return this.parseSequence(path, properties);
    }
    if (char === "{") {
      return this.parseMapping(path, properties);
    }
    if (char === "'" || char === '"') {
      return this.parseQuotedScalar(path, properties);
    }
    if (char === "*") {
      const anchorStart = start + 1;
      let end = anchorStart;
      while (
        end < this.fragment.text.length &&
        !/[\s,[\]{}]/.test(this.fragment.text[end] ?? "") &&
        !(stopAtColon && this.fragment.text[end] === ":")
      ) {
        end += 1;
      }
      const anchor = this.fragment.text.slice(anchorStart, end);
      const range = this.owner.rangeInFragment(this.fragment, start, end);
      this.index = end;
      return this.owner.parseAliasReference(anchor, path, range, this.depth);
    }
    return this.parsePlainScalar(path, stopAtColon, properties);
  }

  private parseSequence(path: string, properties?: NodeProperties): SequenceNode {
    const start = this.index;
    this.index += 1;
    const sequence = this.owner.createSequence(
      path,
      this.owner.rangeInFragment(this.fragment, start, start + 1),
      this.depth + 1,
      properties,
    );
    this.owner.beginOpen(sequence);
    try {
      let itemIndex = 0;
      while (this.index < this.fragment.text.length) {
        this.skipWhitespace();
        if (this.fragment.text[this.index] === "]") {
          this.index += 1;
          break;
        }
        if (this.fragment.text[this.index] === ",") {
          this.index += 1;
          continue;
        }
        const item = this.parseNode(pathForIndex(path, itemIndex), false);
        sequence.items.push(item);
        itemIndex += 1;
        this.skipWhitespace();
        if (this.fragment.text[this.index] === ",") this.index += 1;
      }
    } finally {
      this.owner.endOpen(sequence);
    }
    sequence.range = this.owner.rangeInFragment(this.fragment, start, this.index);
    return sequence;
  }

  private parseMapping(path: string, properties?: NodeProperties): MappingNode {
    const start = this.index;
    this.index += 1;
    const mapping = this.owner.createMapping(
      path,
      this.owner.rangeInFragment(this.fragment, start, start + 1),
      this.depth + 1,
      properties,
    );
    this.owner.beginOpen(mapping);
    try {
      while (this.index < this.fragment.text.length) {
        this.skipWhitespace();
        if (this.fragment.text[this.index] === "}") {
          this.index += 1;
          break;
        }
        if (this.fragment.text[this.index] === ",") {
          this.index += 1;
          continue;
        }
        if (this.fragment.text[this.index] === "?") {
          this.index += 1;
          this.skipWhitespace();
        }
        const key = this.parseNode(path, true);
        const keyText = displayKey(key);
        const valuePath = pathForKey(path, keyText);
        this.skipWhitespace();
        let value: YamlNode;
        if (this.fragment.text[this.index] === ":") {
          this.index += 1;
          this.skipWhitespace();
          const next = this.fragment.text[this.index];
          if (next === "," || next === "}" || next === undefined) {
            const position = this.owner.positionInFragment(this.fragment, this.index);
            value = this.owner.createScalar(
              "",
              "plain",
              undefined,
              valuePath,
              { start: position, end: position },
              this.depth + 2,
            );
          } else {
            value = this.parseNode(valuePath, false);
          }
        } else {
          const position = this.owner.positionInFragment(this.fragment, this.index);
          value = this.owner.createScalar(
            "",
            "plain",
            undefined,
            valuePath,
            { start: position, end: position },
            this.depth + 2,
          );
        }
        mapping.entries.push(
          this.owner.makeRawEntry(key, value, keyText, valuePath),
        );
        this.skipWhitespace();
        if (this.fragment.text[this.index] === ",") this.index += 1;
      }
    } finally {
      this.owner.endOpen(mapping);
    }
    mapping.rawEntries = mapping.entries.slice();
    mapping.range = this.owner.rangeInFragment(this.fragment, start, this.index);
    return mapping;
  }

  private parseQuotedScalar(path: string, properties?: NodeProperties): ScalarNode {
    const start = this.index;
    const quote = this.fragment.text[start]!;
    const end = findClosingQuote(this.fragment.text, quote, start);
    if (end < 0) {
      const position = this.owner.positionInFragment(this.fragment, start);
      throw new YamlSyntaxError(
        `Unterminated quoted scalar at line ${position.line}, column ${position.column}`,
        { path, range: { start: position, end: position } },
      );
    }
    const inner = this.fragment.text.slice(start + 1, end);
    const raw = quote === "'" ? inner.replace(/''/g, "'") : decodeDoubleQuoted(inner);
    const range = this.owner.rangeInFragment(this.fragment, start, end + 1);
    this.index = end + 1;
    return this.owner.createScalar(
      raw,
      quote === "'" ? "single-quoted" : "double-quoted",
      properties?.tag,
      path,
      range,
      this.depth + 1,
      properties?.anchor,
    );
  }

  private parsePlainScalar(
    path: string,
    stopAtColon: boolean,
    properties?: NodeProperties,
  ): ScalarNode {
    const start = this.index;
    while (this.index < this.fragment.text.length) {
      const char = this.fragment.text[this.index]!;
      if (char === "," || char === "]" || char === "}") break;
      if (stopAtColon && char === ":") break;
      if (char === "\n") {
        this.index += 1;
        continue;
      }
      this.index += 1;
    }
    const raw = this.fragment.text.slice(start, this.index).trim();
    const range = this.owner.rangeInFragment(this.fragment, start, this.index);
    return this.owner.createScalar(
      raw,
      "plain",
      properties?.tag,
      path,
      range,
      this.depth + 1,
      properties?.anchor,
    );
  }

  private skipWhitespace(): void {
    while (this.index < this.fragment.text.length) {
      const char = this.fragment.text[this.index]!;
      if (!/\s/.test(char)) break;
      this.index += 1;
    }
  }
}

function lineAt(lines: SourceLine[], index: number): SourceLine {
  if (lines.length === 0) {
    return {
      raw: "",
      text: "",
      content: "",
      indent: 0,
      number: 1,
      offset: 0,
      endOffset: 0,
    };
  }
  return lines[Math.max(0, Math.min(lines.length - 1, index))]!;
}

function splitPath(path: string): string[] {
  const result: string[] = [];
  const regex = /\.([A-Za-z_$][A-Za-z0-9_$-]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(path)) !== null) {
    if (match[1] !== undefined) result.push(match[1]);
    else if (match[2] !== undefined) result.push(`[${match[2]}]`);
    else if (match[3] !== undefined) {
      try {
        result.push(JSON.parse(match[3]) as string);
      } catch {
        result.push(match[3]);
      }
    }
  }
  return result.length > 0 ? result : ["$"];
}

function isMergeKey(key: YamlNode, mergeKeys: boolean): boolean {
  return (
    mergeKeys &&
    key.kind === "scalar" &&
    key.tag === TAGS.merge &&
    key.raw === "<<"
  );
}

function findClosingQuote(text: string, quote: string, start = 0): number {
  if (quote !== "'" && quote !== '"') return -1;
  for (let i = start + 1; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote === "'") {
      if (char === "'" && text[i + 1] === "'") {
        i += 1;
      } else if (char === "'") {
        return i;
      }
    } else {
      if (char === "\\") {
        i += 1;
      } else if (char === '"') {
        return i;
      }
    }
  }
  return -1;
}

function flowIsComplete(text: string): boolean {
  let depth = 0;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote === "'") {
      if (char === "'" && text[i + 1] === "'") i += 1;
      else if (char === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (char === "\\") i += 1;
      else if (char === '"') quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0 && quote === undefined;
}

function foldBlockLines(lines: string[]): string {
  let result = "";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (i > 0) {
      const previous = lines[i - 1]!;
      if (
        previous === "" ||
        line === "" ||
        previous.startsWith(" ") ||
        line.startsWith(" ")
      ) {
        result += "\n";
      } else {
        result += " ";
      }
    }
    result += line;
  }
  return result;
}

function decodeDoubleQuoted(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === "\n") {
      result += " ";
      continue;
    }
    if (char !== "\\") {
      result += char;
      continue;
    }
    i += 1;
    if (i >= text.length) {
      result += "\\";
      break;
    }
    const escaped = text[i]!;
    switch (escaped) {
      case "0":
        result += "\0";
        break;
      case "a":
        result += "\x07";
        break;
      case "b":
        result += "\b";
        break;
      case "t":
      case "\t":
        result += "\t";
        break;
      case "n":
        result += "\n";
        break;
      case "v":
        result += "\v";
        break;
      case "f":
        result += "\f";
        break;
      case "r":
        result += "\r";
        break;
      case "e":
        result += "\x1b";
        break;
      case " ":
        result += " ";
        break;
      case '"':
        result += '"';
        break;
      case "/":
        result += "/";
        break;
      case "\\":
        result += "\\";
        break;
      case "N":
        result += "\u0085";
        break;
      case "_":
        result += "\u00a0";
        break;
      case "L":
        result += "\u2028";
        break;
      case "P":
        result += "\u2029";
        break;
      case "x":
        result += decodeHex(text, i + 1, 2);
        i += 2;
        break;
      case "u":
        result += decodeHex(text, i + 1, 4);
        i += 4;
        break;
      case "U":
        result += decodeHex(text, i + 1, 8);
        i += 8;
        break;
      case "\n":
        while (i + 1 < text.length && /\s/.test(text[i + 1] ?? "")) i += 1;
        break;
      default:
        result += escaped;
    }
  }
  return result;
}

function decodeHex(text: string, start: number, length: number): string {
  const digits = text.slice(start, start + length);
  if (digits.length !== length || !/^[0-9a-fA-F]+$/.test(digits)) return digits;
  return String.fromCodePoint(Number.parseInt(digits, 16));
}
