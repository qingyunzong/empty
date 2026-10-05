/**
 * Incremental, line-based document parser.
 *
 * Recognized constructs:
 *   - ATX headings:        `# Title` .. `###### Title`
 *   - Paragraphs:          maximal runs of plain text lines
 *   - Reference links:     `[text][id]` and collapsed `[id][]`
 *   - Link definitions:    `[id]: url "optional title"` (own line)
 *
 * Rules:
 *   - A reference resolves to the LAST definition of its id in the document.
 *   - Definition lines produce no output nodes.
 *   - Editing a definition only re-resolves the nodes that reference its id.
 *   - Source ranges (start/end offsets) of nodes stay accurate after edits.
 */

export interface LinkDef {
  /** Normalized id (trimmed, whitespace-collapsed, lower-cased). */
  id: string;
  /** Label as written in the source. */
  label: string;
  url: string;
  title?: string;
  /** 0-based line number of the definition. */
  line: number;
}

export interface ResolvedLink {
  text: string;
  id: string;
  url?: string;
  title?: string;
}

export type NodeKind = 'heading' | 'paragraph';

export interface DocNode {
  id: number;
  kind: NodeKind;
  /** Heading level 1-6, only for headings. */
  level?: number;
  startLine: number;
  /** Exclusive. */
  endLine: number;
  /** Absolute character offset of the node start. */
  start: number;
  /** Absolute character offset one past the node end. */
  end: number;
  /** Raw source text of the node. */
  text: string;
  /** Referenced definition ids, in order of appearance. */
  refs: string[];
  /** References resolved against the current definitions. */
  links: ResolvedLink[];
}

export interface EditResult {
  /** Nodes (re)created or re-resolved by this edit. */
  updatedNodeIds: number[];
  /** Nodes removed by this edit. */
  removedNodeIds: number[];
  /** Number of lines actually re-parsed. */
  reparsedLines: number;
  /** Definition ids whose ACTIVE (last) definition changed. */
  changedDefinitions: string[];
}

type BlockKind = 'heading' | 'paragraph' | 'definition' | 'blank';

interface RefOccurrence {
  text: string;
  id: string;
}

interface Block {
  kind: BlockKind;
  startLine: number;
  /** Exclusive. */
  endLine: number;
  level?: number;
  occurrences?: RefOccurrence[];
  refs?: string[];
  links?: ResolvedLink[];
  def?: LinkDef;
  nodeId?: number;
}

const HEADING_RE = /^#{1,6}(?:\s|$)/;
const DEF_RE =
  /^[ \t]{0,3}\[([^\]]+)\]:[ \t]*(\S+)(?:[ \t]+(?:"([^"\n]*)"|'([^'\n]*)'|\(([^)\n]*)\)))?[ \t]*$/;
const REF_RE = /\[([^\]\n]*)\]\[([^\]\n]*)\]/g;
const BLANK_RE = /^[ \t]*$/;

type LineKind = 'blank' | 'heading' | 'definition' | 'text';

function lineKind(line: string): LineKind {
  if (BLANK_RE.test(line)) return 'blank';
  if (HEADING_RE.test(line)) return 'heading';
  if (DEF_RE.test(line)) return 'definition';
  return 'text';
}

function normalizeId(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

function extractRefs(text: string): RefOccurrence[] {
  const out: RefOccurrence[] = [];
  REF_RE.lastIndex = 0;
  for (let m = REF_RE.exec(text); m !== null; m = REF_RE.exec(text)) {
    const label = m[2] === '' ? m[1] : m[2];
    out.push({ text: m[1], id: normalizeId(label) });
  }
  return out;
}

function parseBlockAt(lines: string[], start: number): Block {
  const line = lines[start];
  const kind = lineKind(line);
  if (kind === 'blank') {
    return { kind: 'blank', startLine: start, endLine: start + 1 };
  }
  if (kind === 'heading') {
    const level = /^#+/.exec(line)![0].length;
    const occurrences = extractRefs(line);
    return {
      kind: 'heading',
      startLine: start,
      endLine: start + 1,
      level,
      occurrences,
      refs: occurrences.map((o) => o.id),
    };
  }
  if (kind === 'definition') {
    const m = DEF_RE.exec(line)!;
    const def: LinkDef = {
      id: normalizeId(m[1]),
      label: m[1].trim(),
      url: m[2],
      title: m[3] ?? m[4] ?? m[5],
      line: start,
    };
    return { kind: 'definition', startLine: start, endLine: start + 1, def };
  }
  let end = start + 1;
  while (end < lines.length && lineKind(lines[end]) === 'text') end++;
  const occurrences = extractRefs(lines.slice(start, end).join('\n'));
  return {
    kind: 'paragraph',
    startLine: start,
    endLine: end,
    occurrences,
    refs: occurrences.map((o) => o.id),
  };
}

export class Document {
  private lines: string[];
  private blocks: Block[] = [];
  private nextNodeId = 1;
  /** id -> all definitions of that id, sorted by line ascending. */
  private defs = new Map<string, LinkDef[]>();
  /** definition id -> ids of nodes referencing it. */
  private dependents = new Map<string, Set<number>>();
  private blockByNodeId = new Map<number, Block>();

  constructor(text = '') {
    this.lines = text === '' ? [] : text.split('\n');
    for (let i = 0; i < this.lines.length; ) {
      const block = parseBlockAt(this.lines, i);
      this.blocks.push(block);
      i = block.endLine;
    }
    // Definitions are document-global (last one wins), so collect them all
    // before resolving any references.
    for (const block of this.blocks) {
      if (block.kind === 'definition') this.addDef(block.def!);
    }
    for (const block of this.blocks) {
      if (block.kind === 'heading' || block.kind === 'paragraph') {
        this.registerNodeBlock(block);
      }
    }
  }

  /** Full source text. */
  getText(): string {
    return this.lines.join('\n');
  }

  lineCount(): number {
    return this.lines.length;
  }

  /** Output nodes (headings and paragraphs) in document order. */
  getNodes(): DocNode[] {
    const text = this.getText();
    const offsets = this.lineOffsets();
    const out: DocNode[] = [];
    for (const block of this.blocks) {
      if (block.nodeId === undefined) continue;
      const start = offsets[block.startLine];
      const lastLine = block.endLine - 1;
      const end = offsets[lastLine] + this.lines[lastLine].length;
      const node: DocNode = {
        id: block.nodeId,
        kind: block.kind as NodeKind,
        startLine: block.startLine,
        endLine: block.endLine,
        start,
        end,
        text: text.slice(start, end),
        refs: block.refs!,
        links: block.links!,
      };
      if (block.level !== undefined) node.level = block.level;
      out.push(node);
    }
    return out;
  }

  /** Active (last) definition per id. */
  getDefinitions(): Map<string, LinkDef> {
    const out = new Map<string, LinkDef>();
    for (const [id, list] of this.defs) {
      if (list.length > 0) out.set(id, list[list.length - 1]);
    }
    return out;
  }

  /** Definition id -> ids of nodes that reference it. */
  getDependencies(): Map<string, Set<number>> {
    const out = new Map<string, Set<number>>();
    for (const [id, set] of this.dependents) out.set(id, new Set(set));
    return out;
  }

  /**
   * Replace `deleteCount` lines starting at `startLine` with `newLines`,
   * re-parsing only the affected region and re-resolving only the nodes
   * whose referenced definitions actually changed.
   */
  applyEdit(startLine: number, deleteCount: number, newLines: string[]): EditResult {
    startLine = Math.max(0, Math.min(startLine, this.lines.length));
    deleteCount = Math.max(0, Math.min(deleteCount, this.lines.length - startLine));
    const delta = newLines.length - deleteCount;

    this.lines.splice(startLine, deleteCount, ...newLines);

    // Old blocks intersecting the deleted range: [lo, hi).
    let lo = 0;
    while (lo < this.blocks.length && this.blocks[lo].endLine <= startLine) lo++;
    let hi = lo;
    while (hi < this.blocks.length && this.blocks[hi].startLine < startLine + deleteCount) hi++;

    // If the line now at startLine is a text line and the block right before
    // the edit is a paragraph, they merge: re-parse from that paragraph.
    if (
      lo > 0 &&
      this.blocks[lo - 1].kind === 'paragraph' &&
      this.blocks[lo - 1].endLine === startLine &&
      startLine < this.lines.length &&
      lineKind(this.lines[startLine]) === 'text'
    ) {
      lo--;
    }

    const regionStart = lo < this.blocks.length ? this.blocks[lo].startLine : startLine;
    const insertEnd = startLine + newLines.length;
    const removedBlocks: Block[] = this.blocks.slice(lo, hi);
    const newBlocks: Block[] = [];

    // Re-parse from regionStart until we re-align with an old block boundary
    // (shifted by delta) that cannot merge with what we just parsed.
    let i = regionStart;
    let nextOld = hi;
    while (i < this.lines.length) {
      while (nextOld < this.blocks.length && this.blocks[nextOld].endLine + delta <= i) {
        removedBlocks.push(this.blocks[nextOld]); // absorbed by a merged paragraph
        nextOld++;
      }
      if (i >= insertEnd && nextOld < this.blocks.length && this.blocks[nextOld].startLine + delta === i) {
        const prevKind =
          newBlocks.length > 0
            ? newBlocks[newBlocks.length - 1].kind
            : lo > 0
              ? this.blocks[lo - 1].kind
              : null;
        const mergeable = prevKind === 'paragraph' && this.blocks[nextOld].kind === 'paragraph';
        if (!mergeable) break; // reuse the rest of the old blocks
      }
      const block = parseBlockAt(this.lines, i);
      newBlocks.push(block);
      i = block.endLine;
    }
    while (nextOld < this.blocks.length && this.blocks[nextOld].endLine + delta <= i) {
      removedBlocks.push(this.blocks[nextOld]);
      nextOld++;
    }

    // Snapshot active definitions for every id this edit may touch.
    const touchedIds = new Set<string>();
    for (const block of removedBlocks) if (block.def) touchedIds.add(block.def.id);
    for (const block of newBlocks) if (block.def) touchedIds.add(block.def.id);
    const activeBefore = new Map<string, LinkDef | undefined>();
    for (const id of touchedIds) activeBefore.set(id, this.activeDef(id));

    // Detach removed blocks: definitions, dependents, node ids.
    const removedNodeIds: number[] = [];
    for (const block of removedBlocks) {
      if (block.def) this.removeDef(block.def);
      if (block.nodeId !== undefined) {
        removedNodeIds.push(block.nodeId);
        this.blockByNodeId.delete(block.nodeId);
        for (const id of block.refs ?? []) {
          const set = this.dependents.get(id);
          if (set) {
            set.delete(block.nodeId);
            if (set.size === 0) this.dependents.delete(id);
          }
        }
      }
    }

    // Shift reused trailing blocks to their new line numbers.
    for (let b = nextOld; b < this.blocks.length; b++) {
      const block = this.blocks[b];
      block.startLine += delta;
      block.endLine += delta;
      if (block.def) block.def.line += delta;
    }
    this.blocks = [...this.blocks.slice(0, lo), ...newBlocks, ...this.blocks.slice(nextOld)];

    // Register new blocks: definitions first (resolution is document-global),
    // then output nodes with freshly resolved links.
    for (const block of newBlocks) {
      if (block.def) this.addDef(block.def);
    }
    for (const id of touchedIds) {
      const list = this.defs.get(id);
      if (list && list.length > 1) list.sort((a, b) => a.line - b.line);
    }
    for (const block of newBlocks) {
      if (block.kind === 'heading' || block.kind === 'paragraph') {
        this.registerNodeBlock(block);
      }
    }

    // Which ids got a different ACTIVE definition?
    const changedDefinitions: string[] = [];
    for (const id of touchedIds) {
      if (!sameDef(activeBefore.get(id), this.activeDef(id))) changedDefinitions.push(id);
    }

    // Re-resolve only the nodes that reference a changed definition.
    const updated = new Set<number>();
    for (const block of newBlocks) {
      if (block.nodeId !== undefined) updated.add(block.nodeId);
    }
    for (const id of changedDefinitions) {
      for (const nodeId of this.dependents.get(id) ?? []) {
        const block = this.blockByNodeId.get(nodeId);
        if (block) {
          block.links = this.resolveLinks(block);
          updated.add(nodeId);
        }
      }
    }

    let reparsedLines = 0;
    for (const block of newBlocks) reparsedLines += block.endLine - block.startLine;

    return {
      updatedNodeIds: [...updated].sort((a, b) => a - b),
      removedNodeIds: removedNodeIds.sort((a, b) => a - b),
      reparsedLines,
      changedDefinitions: changedDefinitions.sort(),
    };
  }

  private registerNodeBlock(block: Block): void {
    block.nodeId = this.nextNodeId++;
    block.links = this.resolveLinks(block);
    this.blockByNodeId.set(block.nodeId, block);
    for (const id of block.refs ?? []) {
      let set = this.dependents.get(id);
      if (!set) this.dependents.set(id, (set = new Set()));
      set.add(block.nodeId);
    }
  }

  private resolveLinks(block: Block): ResolvedLink[] {
    return (block.occurrences ?? []).map((occ) => {
      const def = this.activeDef(occ.id);
      const link: ResolvedLink = { text: occ.text, id: occ.id };
      if (def) {
        link.url = def.url;
        if (def.title !== undefined) link.title = def.title;
      }
      return link;
    });
  }

  private activeDef(id: string): LinkDef | undefined {
    const list = this.defs.get(id);
    return list && list.length > 0 ? list[list.length - 1] : undefined;
  }

  private addDef(def: LinkDef): void {
    let list = this.defs.get(def.id);
    if (!list) this.defs.set(def.id, (list = []));
    list.push(def); // blocks are processed in line order, so this stays sorted
  }

  private removeDef(def: LinkDef): void {
    const list = this.defs.get(def.id);
    if (!list) return;
    const idx = list.indexOf(def);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) this.defs.delete(def.id);
  }

  private lineOffsets(): number[] {
    const offsets = new Array<number>(this.lines.length + 1);
    let offset = 0;
    for (let i = 0; i < this.lines.length; i++) {
      offsets[i] = offset;
      offset += this.lines[i].length + 1; // + '\n'
    }
    offsets[this.lines.length] = offset;
    return offsets;
  }
}

function sameDef(a: LinkDef | undefined, b: LinkDef | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.url === b.url && a.title === b.title && a.line === b.line;
}
