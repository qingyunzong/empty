/**
 * Line-oriented parser for a YAML subset (block maps / block sequences /
 * scalars / `#` comments). Every node records exact byte spans so edits can
 * replace only the lexical range of a scalar and leave all other bytes —
 * whitespace, blank lines and comments — untouched.
 */

export interface Line {
  /** Offset of the first byte of the line. */
  start: number;
  /** Offset just past the terminating `\n` (or src.length). */
  end: number;
  /** Number of leading spaces. */
  indent: number;
  /** Line text without leading indent and without the newline. */
  body: string;
  blank: boolean;
  /** True when the first non-space character is `#`. */
  comment: boolean;
}

export interface ScalarNode {
  kind: "scalar";
  value: unknown;
  /** Lexical span of the scalar token; empty (start === end) for implicit null. */
  valueRange: [number, number];
  /** True when the node is an implicit null (`key:` / `-` with no token). */
  implicit: boolean;
  /** Byte range covering the whole node (full lines). */
  range: [number, number];
}

export interface MapEntry {
  key: string;
  keyRange: [number, number];
  /** Start of the entry's first line. */
  lineStart: number;
  node: Node;
}

export interface MapNode {
  kind: "map";
  entries: MapEntry[];
  range: [number, number];
}

export interface SeqItem {
  /** Start of the item's first line (the `-` line). */
  lineStart: number;
  node: Node;
}

export interface SeqNode {
  kind: "seq";
  items: SeqItem[];
  range: [number, number];
}

export type Node = ScalarNode | MapNode | SeqNode;

export interface Document {
  src: string;
  lines: Line[];
  root: Node;
}

export class ParseError extends Error {}

export function splitLines(src: string): Line[] {
  const lines: Line[] = [];
  let pos = 0;
  while (pos <= src.length) {
    const nl = src.indexOf("\n", pos);
    const end = nl === -1 ? src.length : nl + 1;
    const raw = src.slice(pos, nl === -1 ? src.length : nl);
    let indent = 0;
    while (indent < raw.length && raw[indent] === " ") indent++;
    if (raw[indent] === "\t") throw new ParseError(`tab indentation at offset ${pos}`);
    const body = raw.slice(indent);
    const blank = body.trim() === "";
    const comment = !blank && body.startsWith("#");
    lines.push({ start: pos, end, indent, body, blank, comment });
    if (nl === -1) break;
    pos = end;
  }
  return lines;
}

/** Index of the next significant (non-blank, non-comment) line at/after `i`. */
function nextSignificant(lines: Line[], i: number): number {
  while (i < lines.length && (lines[i]!.blank || lines[i]!.comment)) i++;
  return i;
}

/** Find the `: ` (or end-of-line `:`) key separator outside quotes. */
function findKeySep(body: string): number {
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote) {
      if (quote === '"' && c === "\\") i++;
      else if (c === quote) {
        if (quote === "'" && body[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === ":" && (i + 1 === body.length || body[i + 1] === " ")) return i;
  }
  return -1;
}

/** End offset (within body) of a scalar token, stopping at a ` #` comment. */
function scalarTokenEnd(body: string, from: number): number {
  let quote: string | null = null;
  let end = body.length;
  for (let i = from; i < body.length; i++) {
    const c = body[i]!;
    if (quote) {
      if (quote === '"' && c === "\\") i++;
      else if (c === quote) {
        if (quote === "'" && body[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#" && i > from && body[i - 1] === " ") {
      end = i;
      break;
    }
  }
  while (end > from && body[end - 1] === " ") end--;
  return end;
}

const NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

export function parseScalar(token: string): unknown {
  if (token === "") return null;
  if (token.startsWith('"')) {
    try {
      return JSON.parse(token);
    } catch {
      throw new ParseError(`bad double-quoted scalar: ${token}`);
    }
  }
  if (token.startsWith("'")) {
    if (token.length < 2 || !token.endsWith("'")) throw new ParseError(`bad quoted scalar: ${token}`);
    return token.slice(1, -1).replace(/''/g, "'");
  }
  const low = token.toLowerCase();
  if (low === "null" || token === "~") return null;
  if (low === "true") return true;
  if (low === "false") return false;
  if (NUMBER_RE.test(token)) return Number(token);
  return token;
}

interface Frame {
  lines: Line[];
  src: string;
}

function parseBlock(f: Frame, i: number, indent: number): { node: Node; next: number } {
  const first = f.lines[i]!;
  if (first.body === "-" || first.body.startsWith("- ")) return parseSeq(f, i, indent);
  return parseMap(f, i, indent);
}

function parseMap(f: Frame, i: number, indent: number): { node: MapNode; next: number } {
  const entries: MapEntry[] = [];
  const start = f.lines[i]!.start;
  let end = f.lines[i]!.end;
  for (;;) {
    i = nextSignificant(f.lines, i);
    if (i >= f.lines.length) break;
    const line = f.lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new ParseError(`unexpected indent at offset ${line.start}`);
    if (line.body === "-" || line.body.startsWith("- ")) break; // a seq at same indent ends the map
    const sep = findKeySep(line.body);
    if (sep < 0) throw new ParseError(`expected 'key:' at offset ${line.start}`);
    const key = line.body.slice(0, sep).trim();
    if (key === "") throw new ParseError(`empty key at offset ${line.start}`);
    const keyStart = line.start + line.indent + line.body.indexOf(key);
    const keyRange: [number, number] = [keyStart, keyStart + key.length];
    const afterColon = line.start + line.indent + sep + 1;
    const parsed = parseValueAfterIndicator(f, i, indent, afterColon);
    entries.push({ key, keyRange, lineStart: line.start, node: parsed.node });
    end = parsed.node.range[1];
    i = parsed.next;
  }
  return { node: { kind: "map", entries, range: [start, end] }, next: i };
}

function parseSeq(f: Frame, i: number, indent: number): { node: SeqNode; next: number } {
  const items: SeqItem[] = [];
  const start = f.lines[i]!.start;
  let end = f.lines[i]!.end;
  for (;;) {
    i = nextSignificant(f.lines, i);
    if (i >= f.lines.length) break;
    const line = f.lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new ParseError(`unexpected indent at offset ${line.start}`);
    if (!(line.body === "-" || line.body.startsWith("- "))) break;
    const afterDash = line.start + line.indent + 1;
    const parsed = parseValueAfterIndicator(f, i, indent, afterDash);
    items.push({ lineStart: line.start, node: parsed.node });
    end = parsed.node.range[1];
    i = parsed.next;
  }
  return { node: { kind: "seq", items, range: [start, end] }, next: i };
}

/**
 * Parse the value following `key:` or `-` on line `i`.
 * `indicator` is the offset just past the `:` / `-` character.
 */
function parseValueAfterIndicator(
  f: Frame,
  i: number,
  indent: number,
  indicator: number,
): { node: Node; next: number } {
  const line = f.lines[i]!;
  const restStartInBody = indicator - line.start - line.indent;
  const rest = line.body.slice(restStartInBody);

  if (rest.trim() === "" || rest.trimStart().startsWith("#")) {
    // Value (if any) is a nested block on following lines.
    const j = nextSignificant(f.lines, i + 1);
    if (j < f.lines.length && f.lines[j]!.indent > indent) {
      const child = parseBlock(f, j, f.lines[j]!.indent);
      return { node: child.node, next: child.next };
    }
    const node: ScalarNode = {
      kind: "scalar",
      value: null,
      valueRange: [indicator, indicator],
      implicit: true,
      range: [line.start, line.end],
    };
    return { node, next: i + 1 };
  }

  const tokenStartInBody = restStartInBody + (rest.length - rest.trimStart().length);
  const tokenEndInBody = scalarTokenEnd(line.body, tokenStartInBody);
  const token = line.body.slice(tokenStartInBody, tokenEndInBody);
  const absStart = line.start + line.indent + tokenStartInBody;
  const absEnd = line.start + line.indent + tokenEndInBody;

  // `- key: value` — an inline map as a sequence item.
  if (line.body.startsWith("-") ) {
    const sep = findKeySep(token);
    if (sep >= 0 && !token.startsWith('"') && !token.startsWith("'")) {
      const childIndent = line.indent + tokenStartInBody;
      const entries: MapEntry[] = [];
      const key = token.slice(0, sep).trim();
      if (key === "") throw new ParseError(`empty key at offset ${absStart}`);
      const keyStart = absStart + token.indexOf(key);
      const afterColon = absStart + sep + 1;
      const first = parseValueAfterIndicator(f, i, childIndent, afterColon);
      entries.push({ key, keyRange: [keyStart, keyStart + key.length], lineStart: line.start, node: first.node });
      let end = first.node.range[1];
      let next = first.next;
      for (;;) {
        next = nextSignificant(f.lines, next);
        if (next >= f.lines.length) break;
        const l2 = f.lines[next]!;
        if (l2.indent !== childIndent || l2.body === "-" || l2.body.startsWith("- ")) break;
        const sep2 = findKeySep(l2.body);
        if (sep2 < 0) break;
        const key2 = l2.body.slice(0, sep2).trim();
        const keyStart2 = l2.start + l2.indent + l2.body.indexOf(key2);
        const parsed = parseValueAfterIndicator(f, next, childIndent, l2.start + l2.indent + sep2 + 1);
        entries.push({ key: key2, keyRange: [keyStart2, keyStart2 + key2.length], lineStart: l2.start, node: parsed.node });
        end = parsed.node.range[1];
        next = parsed.next;
      }
      const node: MapNode = { kind: "map", entries, range: [line.start, end] };
      return { node, next };
    }
  }

  const node: ScalarNode = {
    kind: "scalar",
    value: parseScalar(token),
    valueRange: [absStart, absEnd],
    implicit: false,
    range: [line.start, line.end],
  };
  return { node, next: i + 1 };
}

export function parse(src: string): Document {
  const lines = splitLines(src);
  const f: Frame = { lines, src };
  const i = nextSignificant(lines, 0);
  let root: Node;
  if (i >= lines.length) {
    root = { kind: "scalar", value: null, valueRange: [0, 0], implicit: true, range: [0, 0] };
  } else {
    const parsed = parseBlock(f, i, lines[i]!.indent);
    if (nextSignificant(lines, parsed.next) < lines.length) {
      const l = lines[nextSignificant(lines, parsed.next)]!;
      throw new ParseError(`unexpected content at offset ${l.start}`);
    }
    root = parsed.node;
  }
  return { src, lines, root };
}

/** Convert a node tree to plain JS data (objects / arrays / scalars). */
export function toPlain(node: Node): unknown {
  switch (node.kind) {
    case "scalar":
      return node.value;
    case "seq":
      return node.items.map((it) => toPlain(it.node));
    case "map": {
      const obj: Record<string, unknown> = {};
      for (const e of node.entries) obj[e.key] = toPlain(e.node);
      return obj;
    }
  }
}
