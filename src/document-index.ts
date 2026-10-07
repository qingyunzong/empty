import { Slugger, plainText } from "./slug";

export interface Heading {
  level: number;
  text: string;
  id: string;
  line: number;
}

export interface Anchor {
  name: string;
  line: number;
}

export interface Reference {
  target: string;
  line: number;
  resolved: boolean;
}

export interface IndexSnapshot {
  headings: Heading[];
  anchors: Anchor[];
  references: Reference[];
}

interface FenceState {
  char: "`" | "~";
  length: number;
}

interface LineInfo {
  /** Fence state at the start of the *next* line. */
  fenceOut: FenceState | null;
  heading?: { level: number; text: string };
  anchors: string[];
  references: string[];
}

const OPEN_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[^\S\n]*(.*)$/;
const CLOSE_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[^\S\n]*$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const CLOSING_HASHES_RE = /[ \t]+#+[ \t]*$/;
const A_TAG_RE = /<a\b[^>]*>/gi;
const A_ATTR_RE = /\b(?:name|id)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i;
const REF_RE = /\[[^\]]*\]\(\s*#([^\s)]+)(?:\s+[^)]*)?\)/g;

function matchOpenFence(line: string): FenceState | null {
  const m = OPEN_FENCE_RE.exec(line);
  if (!m) return null;
  const marks = m[1]!;
  const info = m[2] ?? "";
  // CommonMark: an info string on a backtick fence may not contain backticks.
  if (marks[0] === "`" && info.includes("`")) return null;
  return { char: marks[0] as "`" | "~", length: marks.length };
}

function matchCloseFence(line: string, fence: FenceState): boolean {
  const m = CLOSE_FENCE_RE.exec(line);
  if (!m) return false;
  const marks = m[1]!;
  return marks[0] === fence.char && marks.length >= fence.length;
}

function extractAnchors(line: string): string[] {
  const out: string[] = [];
  A_TAG_RE.lastIndex = 0;
  let tag: RegExpExecArray | null;
  while ((tag = A_TAG_RE.exec(line)) !== null) {
    const attr = A_ATTR_RE.exec(tag[0]);
    if (!attr) continue;
    const name = attr[1] ?? attr[2] ?? attr[3];
    if (name) out.push(name);
  }
  return out;
}

function extractReferences(line: string): string[] {
  const out: string[] = [];
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(line)) !== null) {
    out.push(m[1]!);
  }
  return out;
}

function parseLine(line: string, fence: FenceState | null): LineInfo {
  if (fence) {
    return {
      fenceOut: matchCloseFence(line, fence) ? null : fence,
      anchors: [],
      references: [],
    };
  }
  const open = matchOpenFence(line);
  if (open) return { fenceOut: open, anchors: [], references: [] };

  let heading: LineInfo["heading"];
  const h = HEADING_RE.exec(line);
  if (h) {
    const raw = (h[2] ?? "").replace(CLOSING_HASHES_RE, "");
    heading = { level: h[1]!.length, text: plainText(raw) };
  }
  return {
    fenceOut: null,
    heading,
    anchors: extractAnchors(line),
    references: extractReferences(line),
  };
}

function sameFence(a: FenceState | null | undefined, b: FenceState | null): boolean {
  if (a == null) return b === null;
  return b !== null && a.char === b.char && a.length === b.length;
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

/**
 * Incremental index of a Markdown document: headings (with generated ids),
 * explicit anchors (`<a name="...">` / `<a id="...">`) and internal
 * references (`[text](#target)`). Content inside fenced code blocks is
 * ignored. References may point to anchors defined later in the document.
 *
 * `edit()` re-lexes only the affected lines plus whatever is needed to
 * re-synchronize fence state, so fences spanning the edited region are
 * handled correctly; the resulting index always equals a full re-scan.
 */
export class DocumentIndex {
  private lines: string[];
  private infos: LineInfo[];
  /** Fence state at the start of each line; `fenceAt[lines.length]` is the EOF state. */
  private fenceAt: (FenceState | null)[];
  private snapshot: IndexSnapshot;
  private anchorMap: Map<string, Anchor>;

  constructor(text: string) {
    this.lines = splitLines(text);
    this.infos = new Array<LineInfo>(this.lines.length);
    this.fenceAt = new Array<FenceState | null>(this.lines.length + 1).fill(null);
    let state: FenceState | null = null;
    for (let i = 0; i < this.lines.length; i++) {
      this.fenceAt[i] = state;
      const info = parseLine(this.lines[i]!, state);
      this.infos[i] = info;
      state = info.fenceOut;
    }
    this.fenceAt[this.lines.length] = state;
    this.anchorMap = new Map();
    this.snapshot = { headings: [], anchors: [], references: [] };
    this.reindex();
  }

  get lineCount(): number {
    return this.lines.length;
  }

  get headings(): Heading[] {
    return this.snapshot.headings;
  }

  get anchors(): Anchor[] {
    return this.snapshot.anchors;
  }

  get references(): Reference[] {
    return this.snapshot.references;
  }

  getAnchor(name: string): Anchor | undefined {
    return this.anchorMap.get(name);
  }

  isResolved(target: string): boolean {
    return this.anchorMap.has(target);
  }

  toText(): string {
    return this.lines.join("\n");
  }

  /**
   * Replace `deleteCount` lines starting at `startLine` with `inserted`.
   * Line numbers are 0-based; `startLine` may equal `lineCount` to append.
   */
  edit(startLine: number, deleteCount: number, inserted: string[] | string): void {
    const insertedLines = typeof inserted === "string" ? splitLines(inserted) : inserted;
    if (!Number.isInteger(startLine) || startLine < 0 || startLine > this.lines.length) {
      throw new RangeError(`startLine ${startLine} out of range 0..${this.lines.length}`);
    }
    if (!Number.isInteger(deleteCount) || deleteCount < 0 || startLine + deleteCount > this.lines.length) {
      throw new RangeError(`deleteCount ${deleteCount} out of range`);
    }
    if (deleteCount === 0 && insertedLines.length === 0) return;

    this.lines.splice(startLine, deleteCount, ...insertedLines);
    this.infos.splice(startLine, deleteCount, ...new Array<LineInfo>(insertedLines.length));
    // Boundary `startLine` (state before the edit) survives; the `deleteCount`
    // boundaries after it are dropped and `insertedLines.length` placeholder
    // boundaries are added for the new lines. Placeholders and any boundary
    // whose value may change are recomputed by the re-lex loop below.
    this.fenceAt.splice(
      startLine + 1,
      deleteCount,
      ...new Array<FenceState | null>(insertedLines.length).fill(null),
    );

    const editEnd = startLine + insertedLines.length;
    let state = this.fenceAt[startLine] ?? null;
    let i = startLine;
    while (i < this.lines.length) {
      const info = parseLine(this.lines[i]!, state);
      this.infos[i] = info;
      if (i >= editEnd && sameFence(this.fenceAt[i + 1], info.fenceOut)) {
        // Re-synchronized with the untouched suffix; its per-line results
        // depend only on the fence state at their start, so they stay valid.
        break;
      }
      this.fenceAt[i + 1] = info.fenceOut;
      state = info.fenceOut;
      i++;
    }
    this.reindex();
  }

  /** Rebuild the document-level index from per-line results. */
  private reindex(): void {
    const headings: Heading[] = [];
    const references: Reference[] = [];
    this.anchorMap = new Map();
    const slugger = new Slugger();

    const addAnchor = (name: string, line: number) => {
      if (!this.anchorMap.has(name)) {
        this.anchorMap.set(name, { name, line });
      }
    };

    for (let i = 0; i < this.infos.length; i++) {
      const info = this.infos[i]!;
      if (info.heading) {
        const id = slugger.slug(info.heading.text);
        headings.push({ level: info.heading.level, text: info.heading.text, id, line: i });
        addAnchor(id, i);
      }
      for (const name of info.anchors) addAnchor(name, i);
      for (const target of info.references) references.push({ target, line: i, resolved: false });
    }
    // Resolution happens after the whole document is known, so references
    // may point forward to anchors defined later.
    for (const ref of references) {
      ref.resolved = this.anchorMap.has(ref.target);
    }
    this.snapshot = { headings, anchors: [...this.anchorMap.values()], references };
  }
}

/** One-shot full scan, handy for tests and batch use. */
export function scan(text: string): IndexSnapshot {
  const doc = new DocumentIndex(text);
  return { headings: doc.headings, anchors: doc.anchors, references: doc.references };
}
