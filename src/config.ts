/**
 * config-edit: edit simple `key = value` config files while preserving
 * every untouched byte exactly.
 *
 * Grammar (line oriented):
 *   blank line   : only spaces/tabs
 *   comment line : optional whitespace, then '#', then any text
 *   entry line   : `key = value` with an optional trailing ` # comment`
 *
 * Association rules:
 *   - Comment lines immediately above an entry (no blank line between)
 *     are its leading comments and move together with the key.
 *   - A trailing comment on the same line as a value does NOT belong to
 *     the entry; it is reported separately and never treated as the
 *     leading comment of the following key.
 *   - Comment lines attached to no entry (separated by a blank line, or
 *     sitting at the end of the file) stay in place when keys move.
 *
 * Editing rules:
 *   - `set` replaces only the value's byte span; nothing else is touched.
 *   - Reordering moves a key together with its leading comments.
 *   - Any edit targeting a duplicated key is rejected.
 *   - After every mutation the text is re-parsed and values/comments are
 *     verified against the expected result; on mismatch the edit is
 *     rolled back and an error is thrown.
 */

export interface Span {
  start: number;
  end: number;
}

export interface CommentNode {
  /** Comment text starting at '#', excluding the line terminator. */
  text: string;
  /** Span of the comment text. */
  span: Span;
  /** Span of the whole line, including its line terminator. */
  lineSpan: Span;
}

export interface Entry {
  key: string;
  keySpan: Span;
  value: string;
  /** Exact span of the (trimmed) value; `set` replaces only this range. */
  valueSpan: Span;
  /** Whole `key = value` line including its line terminator. */
  lineSpan: Span;
  /** Comment lines immediately above the entry (no blank line between). */
  leadingComments: CommentNode[];
  /** Same-line comment after the value. Not owned by the entry. */
  trailingComment: CommentNode | null;
}

export interface Document {
  text: string;
  entries: Entry[];
  /** All full-line comments in file order (attached or not). */
  comments: CommentNode[];
  /** Keys that appear more than once. */
  duplicateKeys: string[];
}

const ENTRY_RE = /^[ \t]*([^\s=#]+)[ \t]*=[ \t]*/;
const BLANK_RE = /^[ \t]*$/;
const COMMENT_RE = /^[ \t]*#/;

export function parse(text: string): Document {
  const entries: Entry[] = [];
  const comments: CommentNode[] = [];
  let pending: CommentNode[] = [];
  let pos = 0;
  let lineNo = 1;

  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const next = nl === -1 ? text.length : nl + 1;
    let lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd > pos && text[lineEnd - 1] === "\r") lineEnd--;
    const line = text.slice(pos, lineEnd);
    const lineSpan: Span = { start: pos, end: next };

    if (BLANK_RE.test(line)) {
      pending = [];
    } else if (COMMENT_RE.test(line)) {
      const hash = line.indexOf("#");
      const node: CommentNode = {
        text: line.slice(hash),
        span: { start: pos + hash, end: lineEnd },
        lineSpan,
      };
      comments.push(node);
      pending.push(node);
    } else {
      const m = ENTRY_RE.exec(line);
      if (!m) {
        throw new SyntaxError(`invalid config line ${lineNo}: ${JSON.stringify(line)}`);
      }
      const key = m[1];
      const keyStart = pos + m[0].indexOf(key);
      const restStart = pos + m[0].length;
      const rest = line.slice(m[0].length);

      let commentIdx = -1;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "#" && (i === 0 || rest[i - 1] === " " || rest[i - 1] === "\t")) {
          commentIdx = i;
          break;
        }
      }
      let valueEnd = commentIdx === -1 ? rest.length : commentIdx;
      while (valueEnd > 0 && (rest[valueEnd - 1] === " " || rest[valueEnd - 1] === "\t")) {
        valueEnd--;
      }

      const trailingComment: CommentNode | null =
        commentIdx === -1
          ? null
          : {
              text: rest.slice(commentIdx),
              span: { start: restStart + commentIdx, end: lineEnd },
              lineSpan,
            };

      entries.push({
        key,
        keySpan: { start: keyStart, end: keyStart + key.length },
        value: rest.slice(0, valueEnd),
        valueSpan: { start: restStart, end: restStart + valueEnd },
        lineSpan,
        leadingComments: pending,
        trailingComment,
      });
      pending = [];
    }

    pos = next;
    lineNo++;
  }

  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.key, (counts.get(e.key) ?? 0) + 1);
  const duplicateKeys = [...counts].filter(([, n]) => n > 1).map(([k]) => k);

  return { text, entries, comments, duplicateKeys };
}

type Segment =
  | { kind: "entry"; key: string; value: string; leading: string[]; trailing: string | null }
  | { kind: "raw"; comments: string[] };

/**
 * Logical model of a parsed document: alternating raw stretches (only
 * unattached comments are recorded) and entries carrying their value,
 * leading comments and trailing comment. Used to verify every edit by
 * re-parsing the mutated text and comparing against the expected model.
 */
function snapshot(doc: Document): Segment[] {
  const attached = new Set<CommentNode>();
  for (const e of doc.entries) for (const c of e.leadingComments) attached.add(c);

  const segments: Segment[] = [];
  let raw: string[] = [];
  let ci = 0;
  for (const e of doc.entries) {
    while (ci < doc.comments.length && doc.comments[ci].span.start < e.lineSpan.start) {
      const c = doc.comments[ci++];
      if (!attached.has(c)) raw.push(c.text);
    }
    segments.push({ kind: "raw", comments: raw });
    raw = [];
    segments.push({
      kind: "entry",
      key: e.key,
      value: e.value,
      leading: e.leadingComments.map((c) => c.text),
      trailing: e.trailingComment ? e.trailingComment.text : null,
    });
  }
  while (ci < doc.comments.length) {
    const c = doc.comments[ci++];
    if (!attached.has(c)) raw.push(c.text);
  }
  segments.push({ kind: "raw", comments: raw });
  return segments;
}

function assertSnapshotsEqual(expected: Segment[], actual: Segment[]): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(
      "re-parse validation failed: values/comments mismatch\n" +
        `expected: ${JSON.stringify(expected)}\n` +
        `actual:   ${JSON.stringify(actual)}`
    );
  }
}

function moveInModel(
  segments: Segment[],
  key: string,
  targetKey: string,
  where: "before" | "after"
): Segment[] {
  // Segments alternate raw/entry, starting and ending with raw:
  // raws[i] is the raw stretch preceding entries[i], raws[n] is the tail.
  const raws: string[][] = [];
  const entries: Segment[] = [];
  for (const s of segments) {
    if (s.kind === "raw") raws.push(s.comments);
    else entries.push(s);
  }

  const from = entries.findIndex((s) => s.kind === "entry" && s.key === key);
  const [moved] = entries.splice(from, 1);
  // The raw stretches around the removed entry become adjacent and merge.
  raws.splice(from, 2, [...raws[from], ...raws[from + 1]]);

  const to = entries.findIndex((s) => s.kind === "entry" && s.key === targetKey);
  if (where === "before") {
    // The raw that preceded the target now precedes the moved entry; an
    // empty raw separates the moved entry from the target.
    entries.splice(to, 0, moved);
    raws.splice(to + 1, 0, []);
  } else {
    entries.splice(to + 1, 0, moved);
    raws.splice(to + 1, 0, []);
  }

  const result: Segment[] = [];
  for (let i = 0; i < entries.length; i++) {
    result.push({ kind: "raw", comments: raws[i] }, entries[i]);
  }
  result.push({ kind: "raw", comments: raws[entries.length] });
  return result;
}

function duplicateMessage(key: string, count: number): string {
  return `duplicate key ${JSON.stringify(key)} (${count} occurrences): edit rejected`;
}

function detectNewline(text: string): string {
  const i = text.indexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
}

function assertSettableValue(value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error("value must not contain line breaks");
  }
  if (value !== value.trim()) {
    throw new Error("value must not have leading or trailing whitespace");
  }
  if (value.startsWith("#") || /[ \t]#/.test(value)) {
    throw new Error("value must not contain a comment marker ('#' at start or after whitespace)");
  }
}

export class ConfigEditor {
  private text: string;
  private doc: Document;

  constructor(text: string) {
    this.text = text;
    this.doc = parse(text);
  }

  static parse(text: string): Document {
    return parse(text);
  }

  /** The parse result of the current (post-edit) text. */
  get document(): Document {
    return this.doc;
  }

  keys(): string[] {
    return this.doc.entries.map((e) => e.key);
  }

  has(key: string): boolean {
    return this.doc.entries.some((e) => e.key === key);
  }

  /** Returns the value, `undefined` if absent; throws on duplicate keys. */
  get(key: string): string | undefined {
    const matches = this.doc.entries.filter((e) => e.key === key);
    if (matches.length === 0) return undefined;
    if (matches.length > 1) throw new Error(duplicateMessage(key, matches.length));
    return matches[0].value;
  }

  /** Replaces exactly the value's byte span; every other byte is kept. */
  set(key: string, value: string): void {
    assertSettableValue(value);
    const before = snapshot(this.doc);
    const previousText = this.text;
    const entry = this.uniqueEntry(key);
    this.text =
      this.text.slice(0, entry.valueSpan.start) + value + this.text.slice(entry.valueSpan.end);
    const expected = before.map((s) =>
      s.kind === "entry" && s.key === key ? { ...s, value } : s
    );
    this.commit(expected, previousText);
  }

  /** Moves a key (with its leading comments) to just before `targetKey`. */
  moveBefore(key: string, targetKey: string): void {
    this.move(key, targetKey, "before");
  }

  /** Moves a key (with its leading comments) to just after `targetKey`. */
  moveAfter(key: string, targetKey: string): void {
    this.move(key, targetKey, "after");
  }

  /** Re-parses the current text and verifies values and comments. */
  validate(): void {
    assertSnapshotsEqual(snapshot(this.doc), snapshot(parse(this.text)));
  }

  toString(): string {
    return this.text;
  }

  private move(key: string, targetKey: string, where: "before" | "after"): void {
    if (key === targetKey) return;
    const before = snapshot(this.doc);
    const previousText = this.text;
    const entry = this.uniqueEntry(key);
    this.uniqueEntry(targetKey);

    const blockStart =
      entry.leadingComments.length > 0
        ? entry.leadingComments[0].lineSpan.start
        : entry.lineSpan.start;
    const blockEnd = entry.lineSpan.end;
    const block = this.text.slice(blockStart, blockEnd);
    this.text = this.text.slice(0, blockStart) + this.text.slice(blockEnd);
    this.doc = parse(this.text);

    const target = this.uniqueEntry(targetKey);
    const targetStart =
      target.leadingComments.length > 0
        ? target.leadingComments[0].lineSpan.start
        : target.lineSpan.start;
    const at = where === "before" ? targetStart : target.lineSpan.end;

    const newline = detectNewline(this.text);
    let insert = block;
    if (at > 0 && this.text[at - 1] !== "\n") insert = newline + insert;
    if (!insert.endsWith("\n") && at < this.text.length) insert += newline;
    this.text = this.text.slice(0, at) + insert + this.text.slice(at);

    this.commit(moveInModel(before, key, targetKey, where), previousText);
  }

  private uniqueEntry(key: string): Entry {
    const matches = this.doc.entries.filter((e) => e.key === key);
    if (matches.length === 0) throw new Error(`unknown key: ${JSON.stringify(key)}`);
    if (matches.length > 1) throw new Error(duplicateMessage(key, matches.length));
    return matches[0];
  }

  private commit(expected: Segment[], previousText: string): void {
    const reparsed = parse(this.text);
    try {
      assertSnapshotsEqual(expected, snapshot(reparsed));
    } catch (err) {
      this.text = previousText;
      throw err;
    }
    this.doc = reparsed;
  }
}
