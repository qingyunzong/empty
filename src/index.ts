/**
 * Incremental document index.
 *
 * Extracts ATX headings, explicit anchors (`<a name="...">` / `<a id="...">`)
 * and internal references (`[text](#target)`) from a Markdown-like document,
 * ignoring everything inside fenced code blocks.
 *
 * Heading IDs are derived with `slugify` (ASCII-lowercase, whitespace folded
 * to `-`); duplicates get a numeric suffix. References may be forward: a
 * `[x](#target)` link resolves against anchors defined anywhere in the
 * document, including after the link.
 *
 * `edit()` applies a localized line edit and re-scans only the affected
 * region plus the lines needed for the fence state to re-converge, so a
 * fence that spans the edit region is handled correctly. The resulting
 * snapshot is always identical to a full re-scan of the new text.
 */

import { Slugger } from "./slug.ts";
import {
  OUTSIDE,
  sameFenceState,
  scanLine,
  type FenceState,
  type LineScan,
} from "./scanner.ts";

export { slugify, Slugger } from "./slug.ts";
export type { FenceState, LineScan } from "./scanner.ts";

export interface Heading {
  readonly line: number;
  readonly level: number;
  readonly text: string;
  readonly id: string;
}

export interface Anchor {
  readonly line: number;
  readonly name: string;
}

export interface Reference {
  readonly line: number;
  readonly text: string;
  readonly target: string;
  /** True when `target` names a heading ID or explicit anchor in the doc. */
  readonly resolved: boolean;
}

export interface Snapshot {
  readonly headings: readonly Heading[];
  readonly anchors: readonly Anchor[];
  readonly references: readonly Reference[];
}

function normalizeLine(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export class DocumentIndex {
  private lines: string[];
  private scans: LineScan[];
  private derived: Snapshot | null = null;

  constructor(text: string) {
    this.lines = text.split("\n").map(normalizeLine);
    this.scans = new Array<LineScan>(this.lines.length);
    let state: FenceState = OUTSIDE;
    for (let i = 0; i < this.lines.length; i++) {
      this.scans[i] = scanLine(this.lines[i], state);
      state = this.scans[i].stateAfter;
    }
  }

  static fromText(text: string): DocumentIndex {
    return new DocumentIndex(text);
  }

  get lineCount(): number {
    return this.lines.length;
  }

  /** Current document text. */
  getText(): string {
    return this.lines.join("\n");
  }

  /**
   * Replace `deleteCount` lines starting at `startLine` (0-based) with
   * `inserted` (an array of lines, or a single `\n`-separated string).
   */
  edit(startLine: number, deleteCount: number, inserted: string[] | string): void {
    const newLines = (typeof inserted === "string" ? inserted.split("\n") : inserted).map(
      normalizeLine,
    );
    if (!Number.isInteger(startLine) || startLine < 0 || startLine > this.lines.length) {
      throw new RangeError(`startLine ${startLine} out of range 0..${this.lines.length}`);
    }
    if (!Number.isInteger(deleteCount) || deleteCount < 0 || startLine + deleteCount > this.lines.length) {
      throw new RangeError(`deleteCount ${deleteCount} out of range at line ${startLine}`);
    }

    this.lines.splice(startLine, deleteCount, ...newLines);
    this.scans.splice(startLine, deleteCount, ...new Array<LineScan>(newLines.length));

    // Lines before `startLine` are untouched, so the fence state entering
    // the edit region is still valid. Re-scan the new lines...
    let state: FenceState = startLine === 0 ? OUTSIDE : this.scans[startLine - 1].stateAfter;
    let i = startLine;
    const end = startLine + newLines.length;
    for (; i < end; i++) {
      this.scans[i] = scanLine(this.lines[i], state);
      state = this.scans[i].stateAfter;
    }
    // ...then keep re-scanning old lines until the fence state converges
    // with what was cached. A line whose incoming state is unchanged
    // re-scans to an identical result, so everything after it stays valid.
    while (i < this.lines.length && !sameFenceState(this.scans[i].stateBefore, state)) {
      this.scans[i] = scanLine(this.lines[i], state);
      state = this.scans[i].stateAfter;
      i++;
    }

    this.derived = null;
  }

  /** Headings, anchors and resolved references for the current text. */
  snapshot(): Snapshot {
    if (this.derived === null) this.derived = this.buildSnapshot();
    return this.derived;
  }

  get headings(): readonly Heading[] {
    return this.snapshot().headings;
  }

  get anchors(): readonly Anchor[] {
    return this.snapshot().anchors;
  }

  get references(): readonly Reference[] {
    return this.snapshot().references;
  }

  private buildSnapshot(): Snapshot {
    const slugger = new Slugger();
    const headings: Heading[] = [];
    const anchors: Anchor[] = [];
    const refs: Reference[] = [];
    const ids = new Set<string>();

    for (let line = 0; line < this.scans.length; line++) {
      const scan = this.scans[line];
      for (const h of scan.headings) {
        const id = slugger.slug(h.text);
        ids.add(id);
        headings.push({ line, level: h.level, text: h.text, id });
      }
      for (const name of scan.anchors) {
        ids.add(name);
        anchors.push({ line, name });
      }
      for (const r of scan.refs) {
        refs.push({ line, text: r.text, target: r.target, resolved: false });
      }
    }

    // Resolution happens after the whole document is known, so references
    // may point to anchors defined later (forward references).
    const references = refs.map((r) => ({ ...r, resolved: ids.has(r.target) }));
    return { headings, anchors, references };
  }
}
