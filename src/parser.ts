/**
 * Parser for a block-style YAML subset that retains exact source spans for
 * every token so edits can be applied as minimal text splices.
 *
 * Supported subset:
 *  - block mappings: `key: value`, `key:` + nested block (indent > key indent)
 *  - block sequences: `- value`, `-` + nested block
 *  - scalars: plain / single-quoted / double-quoted (JSON escapes)
 *  - comments: full-line and trailing (`#` preceded by whitespace)
 *  - LF and CRLF line endings
 *
 * Not supported (rejected with ParseError): flow collections, anchors,
 * multi-line scalars, inline mappings inside sequences, tab indentation,
 * sequences at the same indent as their parent mapping key.
 */

export interface Span {
  start: number;
  end: number;
}

export type ScalarValue = string | number | boolean | null;

export interface ScalarNode {
  kind: 'scalar';
  value: ScalarValue;
  /** Lexical span of the scalar token. Zero-width for an empty value (`key:`). */
  span: Span;
  line: number;
}

export interface MapEntry {
  key: string;
  keySpan: Span;
  value: AnyNode;
  /** Line index of the line holding the key. */
  startLine: number;
  /** Line index of the last content line of this entry's subtree (inclusive). */
  endLine: number;
}

export interface MapNode {
  kind: 'map';
  entries: MapEntry[];
  startLine: number;
  endLine: number;
}

export interface SeqItem {
  value: AnyNode;
  startLine: number;
  endLine: number;
}

export interface SeqNode {
  kind: 'seq';
  items: SeqItem[];
  startLine: number;
  endLine: number;
}

export type AnyNode = ScalarNode | MapNode | SeqNode;

export interface LineInfo {
  /** Offset of the first character of the line. */
  start: number;
  /** Offset one past the last content character (before `\r?\n`). */
  end: number;
  /** Offset of the next line's start (=== text.length for the last line). */
  next: number;
  /** Number of leading spaces. */
  indent: number;
  /** Offset of the first non-space character. */
  contentStart: number;
  /** End of content excluding any trailing comment and the whitespace before it. */
  endNoComment: number;
  /** Offset of the `#` starting a trailing/full-line comment, or -1. */
  commentStart: number;
  blank: boolean;
  commentOnly: boolean;
  tabIndent: boolean;
}

export interface Document {
  text: string;
  lines: LineInfo[];
  root: AnyNode;
}

export class ParseError extends Error {
  constructor(message: string, public readonly line?: number) {
    super(line === undefined ? message : `line ${line + 1}: ${message}`);
    this.name = 'ParseError';
  }
}

function isSpace(text: string, i: number): boolean {
  return text[i] === ' ' || text[i] === '\t';
}

/** Scan a line's content region for a trailing comment, respecting quotes. */
function scanComment(text: string, start: number, end: number): { endNoComment: number; commentStart: number } {
  let inSingle = false;
  let inDouble = false;
  let prevSpace = true;
  let commentStart = -1;
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (inSingle) {
      if (c === "'") {
        if (text[i + 1] === "'") i++;
        else inSingle = false;
      }
    } else if (inDouble) {
      if (c === '\\') i++;
      else if (c === '"') inDouble = false;
    } else if (c === "'") {
      inSingle = true;
    } else if (c === '"') {
      inDouble = true;
    } else if (c === '#' && prevSpace) {
      commentStart = i;
      break;
    }
    prevSpace = c === ' ' || c === '\t';
  }
  const contentEnd = commentStart === -1 ? end : commentStart;
  let trimmed = contentEnd;
  while (trimmed > start && isSpace(text, trimmed - 1)) trimmed--;
  return { endNoComment: trimmed, commentStart };
}

export function splitLines(text: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const next = nl === -1 ? text.length : nl + 1;
    let end = nl === -1 ? text.length : nl;
    if (end > pos && text[end - 1] === '\r') end--;
    let indent = 0;
    let tabIndent = false;
    let p = pos;
    while (p < end && isSpace(text, p)) {
      if (text[p] === '\t') tabIndent = true;
      else indent++;
      p++;
    }
    const { endNoComment, commentStart } = scanComment(text, p, end);
    const blank = p >= end;
    const commentOnly = !blank && commentStart === p;
    lines.push({ start: pos, end, next, indent, contentStart: p, endNoComment, commentStart, blank, commentOnly, tabIndent });
    pos = next;
  }
  return lines;
}

/** Type a plain (unquoted) scalar token. */
export function typePlain(token: string): ScalarValue {
  if (/^(~|null|Null|NULL)$/.test(token)) return null;
  if (/^(true|True|TRUE)$/.test(token)) return true;
  if (/^(false|False|FALSE)$/.test(token)) return false;
  if (/^[-+]?\d+$/.test(token)) {
    const n = Number(token);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(token)) {
    return Number(token);
  }
  return token;
}

function parseScalarToken(text: string, start: number, end: number, line: number): ScalarNode {
  const c = text[start];
  if (c === '"') {
    let i = start + 1;
    while (i < end) {
      if (text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text[i] === '"') break;
      i++;
    }
    if (i >= end) throw new ParseError('unterminated double-quoted scalar', line);
    const raw = text.slice(start, i + 1);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ParseError('invalid escape in double-quoted scalar', line);
    }
    if (typeof value !== 'string') throw new ParseError('invalid double-quoted scalar', line);
    return { kind: 'scalar', value, span: { start, end: i + 1 }, line };
  }
  if (c === "'") {
    let i = start + 1;
    while (i < end) {
      if (text[i] === "'") {
        if (text[i + 1] === "'") {
          i += 2;
          continue;
        }
        break;
      }
      i++;
    }
    if (i >= end) throw new ParseError('unterminated single-quoted scalar', line);
    const value = text.slice(start + 1, i).replace(/''/g, "'");
    return { kind: 'scalar', value, span: { start, end: i + 1 }, line };
  }
  const token = text.slice(start, end);
  return { kind: 'scalar', value: typePlain(token), span: { start, end }, line };
}

/** Find the `:` separating a mapping key, or -1. A key colon is followed by space/EOL. */
function findKeyColon(text: string, start: number, end: number): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (inSingle) {
      if (c === "'") {
        if (text[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (c === '\\') i++;
      else if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") inSingle = true;
    else if (c === '"') inDouble = true;
    else if (c === ':' && (i + 1 >= end || isSpace(text, i + 1))) return i;
  }
  return -1;
}

function parseKey(text: string, start: number, colon: number, line: number): { key: string; keySpan: Span } {
  let e = colon;
  while (e > start && isSpace(text, e - 1)) e--;
  if (e === start) throw new ParseError('empty mapping key', line);
  if (text[start] === '"' || text[start] === "'") {
    const tok = parseScalarToken(text, start, e, line);
    if (typeof tok.value !== 'string') throw new ParseError('invalid quoted key', line);
    return { key: tok.value, keySpan: tok.span };
  }
  return { key: text.slice(start, e), keySpan: { start, end: e } };
}

function isDashLine(text: string, line: LineInfo): boolean {
  const i = line.contentStart;
  return text[i] === '-' && (i + 1 >= line.endNoComment || isSpace(text, i + 1));
}

interface State {
  text: string;
  lines: LineInfo[];
  ptr: number;
}

function nextContent(lines: LineInfo[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    const l = lines[i];
    if (!l.blank && !l.commentOnly) return i;
  }
  return -1;
}

function endLineOf(node: AnyNode): number {
  return node.kind === 'scalar' ? node.line : node.endLine;
}

function parseNode(st: State, i: number): AnyNode {
  const line = st.lines[i];
  if (line.tabIndent) throw new ParseError('tab indentation is not allowed', i);
  if (isDashLine(st.text, line)) return parseSeq(st, i, line.indent);
  const colon = findKeyColon(st.text, line.contentStart, line.endNoComment);
  if (colon !== -1) return parseMap(st, i, line.indent);
  const node = parseScalarToken(st.text, line.contentStart, line.endNoComment, i);
  st.ptr = i + 1;
  return node;
}

function parseMap(st: State, firstLine: number, indent: number): MapNode {
  const { text, lines } = st;
  st.ptr = firstLine;
  const entries: MapEntry[] = [];
  let endLine = firstLine;
  for (;;) {
    const li = nextContent(lines, st.ptr);
    if (li === -1) {
      st.ptr = lines.length;
      break;
    }
    const line = lines[li];
    if (line.indent < indent) {
      st.ptr = li;
      break;
    }
    if (line.indent > indent) throw new ParseError('unexpected indentation', li);
    if (line.tabIndent) throw new ParseError('tab indentation is not allowed', li);
    if (isDashLine(text, line)) throw new ParseError('unexpected sequence entry in mapping', li);
    const colon = findKeyColon(text, line.contentStart, line.endNoComment);
    if (colon === -1) throw new ParseError('expected "key:" in mapping', li);
    const { key, keySpan } = parseKey(text, line.contentStart, colon, li);
    let value: AnyNode;
    let valStart = colon + 1;
    while (valStart < line.endNoComment && isSpace(text, valStart)) valStart++;
    if (valStart < line.endNoComment) {
      value = parseScalarToken(text, valStart, line.endNoComment, li);
      st.ptr = li + 1;
      endLine = li;
    } else {
      const ni = nextContent(lines, li + 1);
      if (ni !== -1 && lines[ni].indent > indent) {
        value = parseNode(st, ni);
        endLine = endLineOf(value);
      } else {
        value = { kind: 'scalar', value: null, span: { start: colon + 1, end: colon + 1 }, line: li };
        st.ptr = li + 1;
        endLine = li;
      }
    }
    entries.push({ key, keySpan, value, startLine: li, endLine });
  }
  return { kind: 'map', entries, startLine: firstLine, endLine };
}

function parseSeq(st: State, firstLine: number, indent: number): SeqNode {
  const { text, lines } = st;
  st.ptr = firstLine;
  const items: SeqItem[] = [];
  let endLine = firstLine;
  for (;;) {
    const li = nextContent(lines, st.ptr);
    if (li === -1) {
      st.ptr = lines.length;
      break;
    }
    const line = lines[li];
    if (line.indent < indent) {
      st.ptr = li;
      break;
    }
    if (line.indent > indent) throw new ParseError('unexpected indentation', li);
    if (line.tabIndent) throw new ParseError('tab indentation is not allowed', li);
    if (!isDashLine(text, line)) {
      st.ptr = li;
      break;
    }
    const dashPos = line.contentStart;
    let valStart = dashPos + 1;
    while (valStart < line.endNoComment && isSpace(text, valStart)) valStart++;
    let value: AnyNode;
    if (valStart < line.endNoComment) {
      if (findKeyColon(text, valStart, line.endNoComment) !== -1) {
        throw new ParseError('inline mappings in sequences are not supported', li);
      }
      value = parseScalarToken(text, valStart, line.endNoComment, li);
      st.ptr = li + 1;
      endLine = li;
    } else {
      const ni = nextContent(lines, li + 1);
      if (ni !== -1 && lines[ni].indent > indent) {
        value = parseNode(st, ni);
        endLine = endLineOf(value);
      } else {
        value = { kind: 'scalar', value: null, span: { start: dashPos + 1, end: dashPos + 1 }, line: li };
        st.ptr = li + 1;
        endLine = li;
      }
    }
    items.push({ value, startLine: li, endLine });
  }
  return { kind: 'seq', items, startLine: firstLine, endLine };
}

export function parse(text: string): Document {
  const lines = splitLines(text);
  const st: State = { text, lines, ptr: 0 };
  const first = nextContent(lines, 0);
  let root: AnyNode;
  if (first === -1) {
    root = { kind: 'scalar', value: null, span: { start: 0, end: 0 }, line: 0 };
  } else {
    root = parseNode(st, first);
    const rest = nextContent(lines, st.ptr);
    if (rest !== -1) throw new ParseError('unexpected content', rest);
  }
  return { text, lines, root };
}
