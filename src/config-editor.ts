/**
 * Span-preserving editor for simple `key = value` config files.
 *
 * Line model:
 *   - blank line            -> fixed atom, never moves
 *   - comment line (# or ;) -> attaches to the entry directly below it when
 *                              there is no blank line in between; otherwise fixed
 *   - `key = value` line    -> entry; only the value span is ever rewritten
 *   - trailing comment after a value (`key = value  # note`) does NOT belong
 *     to the entry: it stays in place when entries are reordered
 *
 * Guarantees:
 *   - `set` rewrites only the value's byte span; every other byte is preserved
 *   - `reorder` moves each entry together with its attached leading comments
 *   - documents containing duplicate keys reject all edits
 *   - after every mutation the result is re-parsed and verified (values and
 *     comments must survive intact)
 */

const COMMENT_PREFIXES = new Set(['#', ';']);

type AtomKind =
  | 'comment'
  | 'blank'
  | 'raw'
  | 'entry-head'
  | 'trailing-comment'
  | 'newline';

interface Atom {
  kind: AtomKind;
  text: string;
}

interface EntryInfo {
  key: string;
  value: string;
  /** Index of the 'entry-head' atom. */
  headAtomIndex: number;
  /** Absolute offset of the head atom in the document. */
  headOffset: number;
  /** Absolute offsets of the value span. */
  valueStart: number;
  valueEnd: number;
  /** Atom index where this entry's group (attached comments + head) starts. */
  groupStart: number;
}

function isCommentChar(ch: string): boolean {
  return COMMENT_PREFIXES.has(ch);
}

function isHSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t';
}

function stripTerminator(text: string): string {
  return text.replace(/\r?\n$/, '');
}

export class ConfigDocument {
  private atoms: Atom[] = [];
  private entryList: EntryInfo[] = [];
  private byKey = new Map<string, EntryInfo>();
  private duplicateKeys: string[] = [];

  private constructor() {}

  static parse(text: string): ConfigDocument {
    const doc = new ConfigDocument();
    doc.rebuild(text);
    return doc;
  }

  /** Keys in document order. */
  keys(): string[] {
    return this.entryList.map((e) => e.key);
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  get(key: string): string | undefined {
    return this.byKey.get(key)?.value;
  }

  /** Keys that appear more than once (edits are rejected while non-empty). */
  duplicates(): string[] {
    return [...this.duplicateKeys];
  }

  /** All comment texts in document order (line comments and trailing comments). */
  comments(): string[] {
    return this.commentTexts();
  }

  toString(): string {
    return this.atoms.map((a) => a.text).join('');
  }

  /**
   * Set `key` to `value`. Existing keys have only their value span replaced;
   * unknown keys are appended as `key = value` at the end of the document.
   */
  set(key: string, value: string): void {
    this.assertEditable();
    const k = ConfigDocument.validateKey(key);
    ConfigDocument.validateValue(value);

    const expected = this.expectedEntries();
    const commentsBefore = this.commentTexts();

    const entry = this.byKey.get(k);
    if (entry) {
      const head = this.atoms[entry.headAtomIndex];
      const relStart = entry.valueStart - entry.headOffset;
      const relEnd = entry.valueEnd - entry.headOffset;
      head.text = head.text.slice(0, relStart) + value + head.text.slice(relEnd);
      expected.set(k, value);
      this.rebuild(this.toString());
    } else {
      let text = this.toString();
      if (text.length > 0 && !text.endsWith('\n')) text += '\n';
      text += `${k} = ${value}\n`;
      expected.set(k, value);
      this.rebuild(text);
    }

    this.verify(expected, commentsBefore);
  }

  /**
   * Reorder entries. `order` must be a permutation of all keys.
   * Each entry moves together with its attached leading comments; blank
   * lines, unattached comments and trailing comments stay in place.
   */
  reorder(order: string[]): void {
    this.assertEditable();
    const known = new Set(this.keys());
    if (
      order.length !== known.size ||
      new Set(order).size !== order.length ||
      !order.every((k) => known.has(k))
    ) {
      throw new Error(
        `reorder expects a permutation of all keys (${[...known].join(', ')})`,
      );
    }

    const expected = this.expectedEntries();
    const commentsBefore = this.commentTexts();

    const groupAtoms = new Map<string, Atom[]>();
    const groupStarts = new Map<number, EntryInfo>();
    for (const entry of this.entryList) {
      groupAtoms.set(
        entry.key,
        this.atoms.slice(entry.groupStart, entry.headAtomIndex + 1),
      );
      groupStarts.set(entry.groupStart, entry);
    }

    const next: Atom[] = [];
    let groupIndex = 0;
    let i = 0;
    while (i < this.atoms.length) {
      const group = groupStarts.get(i);
      if (group) {
        const key = order[groupIndex++];
        next.push(...groupAtoms.get(key)!);
        i = group.headAtomIndex + 1;
      } else {
        next.push(this.atoms[i]);
        i++;
      }
    }
    this.atoms = next;

    this.rebuild(this.toString());
    this.verify(expected, commentsBefore);
  }

  // ------------------------------------------------------------------ private

  private static validateKey(key: string): string {
    const k = key.trim();
    if (k.length === 0 || /[=\r\n]/.test(k) || isCommentChar(k[0])) {
      throw new Error(`invalid key: ${JSON.stringify(key)}`);
    }
    return k;
  }

  private static validateValue(value: string): void {
    if (/[\r\n]/.test(value)) {
      throw new Error('value may not contain line breaks');
    }
    if (value !== value.trim()) {
      throw new Error('value may not have leading or trailing whitespace');
    }
    if (/(^|\s)[#;]/.test(value)) {
      throw new Error(
        `value ${JSON.stringify(value)} would be parsed as containing a comment`,
      );
    }
  }

  private assertEditable(): void {
    if (this.duplicateKeys.length > 0) {
      throw new Error(
        `refusing to edit: duplicate keys present (${this.duplicateKeys.join(', ')})`,
      );
    }
  }

  private expectedEntries(): Map<string, string> {
    return new Map(this.entryList.map((e) => [e.key, e.value]));
  }

  private commentTexts(): string[] {
    const out: string[] = [];
    for (const atom of this.atoms) {
      if (atom.kind === 'comment') out.push(stripTerminator(atom.text).trim());
      else if (atom.kind === 'trailing-comment') out.push(atom.text.trim());
    }
    return out;
  }

  /**
   * Re-parse verification: after every mutation the serialized document is
   * parsed again and must yield exactly the expected key/value pairs and the
   * same multiset of comments.
   */
  private verify(expected: Map<string, string>, commentsBefore: string[]): void {
    if (this.duplicateKeys.length > 0) {
      throw new Error(
        `verification failed: edit introduced duplicate keys (${this.duplicateKeys.join(', ')})`,
      );
    }
    const actual = this.expectedEntries();
    if (actual.size !== expected.size || ![...expected].every(([k, v]) => actual.get(k) === v)) {
      throw new Error('verification failed: re-parsed values differ from edit intent');
    }
    const sorted = (xs: string[]) => [...xs].sort();
    const before = sorted(commentsBefore);
    const after = sorted(this.commentTexts());
    if (before.length !== after.length || before.some((c, i) => c !== after[i])) {
      throw new Error('verification failed: comments were lost or altered');
    }
  }

  private rebuild(text: string): void {
    this.atoms = [];
    this.entryList = [];
    this.byKey = new Map();
    this.duplicateKeys = [];

    let pos = 0;
    while (pos < text.length) {
      const nl = text.indexOf('\n', pos);
      let end: number;
      let term: string;
      if (nl === -1) {
        end = text.length;
        term = '';
      } else {
        end = nl;
        term = '\n';
        if (end > pos && text[end - 1] === '\r') {
          end--;
          term = '\r\n';
        }
      }
      this.parseLine(text.slice(pos, end), term, pos);
      pos = end + term.length;
    }

    const seen = new Map<string, number>();
    for (const entry of this.entryList) {
      seen.set(entry.key, (seen.get(entry.key) ?? 0) + 1);
      if (!this.byKey.has(entry.key)) this.byKey.set(entry.key, entry);
    }
    this.duplicateKeys = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  }

  private parseLine(body: string, term: string, offset: number): void {
    const trimmed = body.trim();

    if (trimmed === '') {
      this.atoms.push({ kind: 'blank', text: body + term });
      return;
    }
    if (isCommentChar(trimmed[0])) {
      this.atoms.push({ kind: 'comment', text: body + term });
      return;
    }

    const eq = body.indexOf('=');
    const key = eq >= 0 ? body.slice(0, eq).trim() : '';
    if (eq < 0 || key === '' || isCommentChar(key[0])) {
      // Unrecognized content: kept verbatim as a fixed atom.
      this.atoms.push({ kind: 'raw', text: body + term });
      return;
    }

    const rest = body.slice(eq + 1);
    let commentAt = -1;
    for (let i = 0; i < rest.length; i++) {
      if (isCommentChar(rest[i]) && (i === 0 || isHSpace(rest[i - 1]))) {
        commentAt = i;
        break;
      }
    }

    let valuePart: string;
    let trailing: string | null = null;
    if (commentAt === -1) {
      valuePart = rest;
    } else {
      let gap = commentAt;
      while (gap > 0 && isHSpace(rest[gap - 1])) gap--;
      valuePart = rest.slice(0, gap);
      trailing = rest.slice(gap);
    }

    const value = valuePart.trim();
    const leadWs = valuePart.length - valuePart.trimStart().length;
    const valueStart = offset + eq + 1 + leadWs;

    const headAtomIndex = this.atoms.length;
    this.atoms.push({ kind: 'entry-head', text: body.slice(0, eq + 1 + valuePart.length) });
    if (trailing !== null) {
      this.atoms.push({ kind: 'trailing-comment', text: trailing });
    }
    this.atoms.push({ kind: 'newline', text: term });

    let groupStart = headAtomIndex;
    while (groupStart > 0 && this.atoms[groupStart - 1].kind === 'comment') {
      groupStart--;
    }

    this.entryList.push({
      key,
      value,
      headAtomIndex,
      headOffset: offset,
      valueStart,
      valueEnd: valueStart + value.length,
      groupStart,
    });
  }
}
