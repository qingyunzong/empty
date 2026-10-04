import {
  classifyLine,
  parseBlocks,
  parseDefinition,
  type RawBlock,
  type RawLink,
} from './parser.js';

export interface LinkRef {
  text: string;
  label: string;
  target: string | null;
}

export interface DocNode {
  id: number;
  version: number;
  kind: 'heading' | 'paragraph';
  level: number;
  text: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  links: LinkRef[];
  deps: Set<number>;
}

export interface EditReport {
  startLine: number;
  deleteCount: number;
  insertedCount: number;
  delta: number;
  reparseRange: { startLine: number; endLine: number };
  updatedNodeIds: number[];
}

interface DefEntry {
  line: number;
  url: string;
}

function sameLinks(a: LinkRef[] | RawLink[], b: LinkRef[] | RawLink[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].text !== b[i].text || a[i].label !== b[i].label) return false;
    const ta = 'target' in a[i] ? (a[i] as LinkRef).target : undefined;
    const tb = 'target' in b[i] ? (b[i] as LinkRef).target : undefined;
    if (ta !== undefined && tb !== undefined && ta !== tb) return false;
  }
  return true;
}

function sameContent(a: DocNode, b: DocNode): boolean {
  return (
    a.kind === b.kind &&
    a.level === b.level &&
    a.text === b.text &&
    sameLinks(a.links, b.links)
  );
}

export class Document {
  lines: string[];
  nodes: DocNode[] = [];
  private defs = new Map<string, DefEntry[]>();
  private nextId = 1;
  private lineOffsets: number[] = [];

  constructor(text: string) {
    this.lines = text.split('\n');
    for (let i = 0; i < this.lines.length; i++) {
      const def = parseDefinition(this.lines[i]);
      if (def) this.addDef(def.label, { line: i, url: def.url });
    }
    this.nodes = parseBlocks(this.lines, 0, this.lines.length).map((block) =>
      this.makeNode(block),
    );
    this.recomputeOffsets();
  }

  static parse(text: string): Document {
    return new Document(text);
  }

  get text(): string {
    return this.lines.join('\n');
  }

  applyEdit(startLine: number, deleteCount: number, insertedLines: string[]): EditReport {
    if (
      !Number.isInteger(startLine) ||
      startLine < 0 ||
      startLine > this.lines.length ||
      !Number.isInteger(deleteCount) ||
      deleteCount < 0 ||
      startLine + deleteCount > this.lines.length
    ) {
      throw new RangeError(`invalid edit range ${startLine}+${deleteCount}`);
    }
    const oldEnd = startLine + deleteCount;
    const insertedCount = insertedLines.length;
    const delta = insertedCount - deleteCount;
    const report: EditReport = {
      startLine,
      deleteCount,
      insertedCount,
      delta,
      reparseRange: { startLine, endLine: startLine },
      updatedNodeIds: [],
    };
    if (deleteCount === 0 && insertedCount === 0) return report;

    const touched = new Set<string>();
    for (const [label, entries] of this.defs) {
      for (const entry of entries) {
        if (entry.line >= startLine && entry.line < oldEnd) {
          touched.add(label);
          break;
        }
      }
    }
    const addedDefs: { label: string; entry: DefEntry }[] = [];
    insertedLines.forEach((line, index) => {
      const def = parseDefinition(line);
      if (def) {
        touched.add(def.label);
        addedDefs.push({ label: def.label, entry: { line: startLine + index, url: def.url } });
      }
    });
    const oldTargets = new Map<string, string | null>();
    for (const label of touched) oldTargets.set(label, this.resolve(label));

    this.lines.splice(startLine, deleteCount, ...insertedLines);

    for (const [label, entries] of this.defs) {
      const kept: DefEntry[] = [];
      for (const entry of entries) {
        if (entry.line >= startLine && entry.line < oldEnd) continue;
        kept.push({ line: entry.line >= oldEnd ? entry.line + delta : entry.line, url: entry.url });
      }
      if (kept.length === 0) this.defs.delete(label);
      else this.defs.set(label, kept);
    }
    for (const { label, entry } of addedDefs) this.addDef(label, entry);

    const dirty = new Set<string>();
    for (const label of touched) {
      if (this.resolve(label) !== oldTargets.get(label)) dirty.add(label);
    }

    let regStart = startLine;
    let regEnd = oldEnd;
    for (const node of this.nodes) {
      if (node.endLine > regStart && node.startLine < regEnd) {
        regStart = Math.min(regStart, node.startLine);
        regEnd = Math.max(regEnd, node.endLine);
      }
    }
    const isText = (index: number): boolean =>
      index >= 0 && index < this.lines.length && classifyLine(this.lines[index]) === 'text';
    if (isText(startLine - 1) && isText(startLine)) {
      const left = this.nodes.find((n) => n.startLine <= startLine - 1 && startLine - 1 < n.endLine);
      if (left) regStart = Math.min(regStart, left.startLine);
    }
    const rightNew = startLine + insertedCount;
    if (isText(rightNew - 1) && isText(rightNew)) {
      const oldLine = rightNew - delta;
      const right = this.nodes.find((n) => n.startLine <= oldLine && oldLine < n.endLine);
      if (right) regEnd = Math.max(regEnd, right.endLine);
    }

    const newRegStart = regStart;
    const newRegEnd = regEnd + delta;
    report.reparseRange = { startLine: newRegStart, endLine: newRegEnd };

    const before = this.nodes.filter((n) => n.endLine <= regStart);
    const regionNodes = this.nodes.filter((n) => n.endLine > regStart && n.startLine < regEnd);
    const after = this.nodes.filter((n) => n.startLine >= regEnd);

    const blocks = parseBlocks(this.lines, newRegStart, newRegEnd);
    const candidates = blocks.map((block) => this.makeNode(block));

    const reused = new Set<DocNode>();
    const pairCount = Math.min(regionNodes.length, candidates.length);
    for (let i = 0; i < pairCount; i++) {
      const oldNode = regionNodes[i];
      const candidate = candidates[i];
      if (sameContent(oldNode, candidate)) {
        oldNode.startLine = candidate.startLine;
        oldNode.endLine = candidate.endLine;
        oldNode.deps = this.computeDeps(oldNode);
        candidates[i] = oldNode;
        reused.add(oldNode);
      }
    }

    const updatedIds = new Set<number>();
    for (const candidate of candidates) {
      if (!reused.has(candidate)) updatedIds.add(candidate.id);
    }

    for (const node of after) {
      node.startLine += delta;
      node.endLine += delta;
    }

    const kept = [...before, ...after];
    const replacements = new Map<DocNode, DocNode>();
    for (const node of kept) {
      let changed = false;
      const links = node.links.map((link) => {
        const target = this.resolve(link.label);
        if (target !== link.target) changed = true;
        return target === link.target ? link : { ...link, target };
      });
      const deps = this.computeDeps(node);
      if (changed) {
        const replacement: DocNode = { ...node, links, deps, version: node.version + 1 };
        replacements.set(node, replacement);
        updatedIds.add(node.id);
      } else {
        node.deps = deps;
      }
    }

    this.nodes = [
      ...before.map((n) => replacements.get(n) ?? n),
      ...candidates,
      ...after.map((n) => replacements.get(n) ?? n),
    ];

    this.recomputeOffsets();
    report.updatedNodeIds = [...updatedIds];
    return report;
  }

  private addDef(label: string, entry: DefEntry): void {
    const entries = this.defs.get(label);
    if (!entries) {
      this.defs.set(label, [entry]);
      return;
    }
    entries.push(entry);
    entries.sort((a, b) => a.line - b.line);
  }

  private resolve(label: string): string | null {
    const entries = this.defs.get(label);
    if (!entries || entries.length === 0) return null;
    return entries[entries.length - 1].url;
  }

  private resolveLine(label: string): number | null {
    const entries = this.defs.get(label);
    if (!entries || entries.length === 0) return null;
    return entries[entries.length - 1].line;
  }

  private makeNode(block: RawBlock): DocNode {
    const links: LinkRef[] = block.links.map((link) => ({
      text: link.text,
      label: link.label,
      target: this.resolve(link.label),
    }));
    const node: DocNode = {
      id: this.nextId++,
      version: 1,
      kind: block.kind,
      level: block.level,
      text: block.text,
      startLine: block.startLine,
      endLine: block.endLine,
      startOffset: 0,
      endOffset: 0,
      links,
      deps: new Set<number>(),
    };
    node.deps = this.computeDeps(node);
    return node;
  }

  private computeDeps(node: DocNode): Set<number> {
    const deps = new Set<number>();
    for (let line = node.startLine; line < node.endLine; line++) deps.add(line);
    for (const link of node.links) {
      const defLine = this.resolveLine(link.label);
      if (defLine !== null) deps.add(defLine);
    }
    return deps;
  }

  private recomputeOffsets(): void {
    this.lineOffsets = new Array(this.lines.length);
    let offset = 0;
    for (let i = 0; i < this.lines.length; i++) {
      this.lineOffsets[i] = offset;
      offset += this.lines[i].length + 1;
    }
    for (const node of this.nodes) {
      node.startOffset = this.lineOffsets[node.startLine];
      node.endOffset =
        this.lineOffsets[node.endLine - 1] + this.lines[node.endLine - 1].length;
    }
  }
}
