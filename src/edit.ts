/**
 * Span-based edits on a parsed Document. Edits only ever touch the lexical
 * range of the target scalar (set) or the whole lines of the target item
 * (delete); every other byte of the source is preserved verbatim.
 */
import {
  Document,
  Line,
  MapNode,
  Node,
  SeqNode,
  parseScalar,
} from "./parser.js";

export type PathSegment = string | number;
export type Path = PathSegment[];

export interface Edit {
  start: number;
  end: number;
  insert: string;
}

export interface EditResult {
  changed: boolean;
  text: string;
  edits: Edit[];
}

export function applyEdits(src: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of sorted) out = out.slice(0, e.start) + e.insert + out.slice(e.end);
  return out;
}

interface Slot {
  container: MapNode | SeqNode;
  index: number;
}

interface Resolution {
  node: Node;
  /** Slots from the outermost container down to the node's direct parent. */
  chain: Slot[];
}

export function resolve(root: Node, path: Path): Resolution | null {
  let node = root;
  const chain: Slot[] = [];
  for (const seg of path) {
    if (node.kind === "map") {
      const idx = node.entries.findIndex((e) => e.key === String(seg));
      if (idx < 0) return null;
      chain.push({ container: node, index: idx });
      node = node.entries[idx]!.node;
    } else if (node.kind === "seq") {
      const idx = typeof seg === "number" ? seg : /^\d+$/.test(seg) ? Number(seg) : -1;
      if (idx < 0 || idx >= node.items.length) return null;
      chain.push({ container: node, index: idx });
      node = node.items[idx]!.node;
    } else {
      return null;
    }
  }
  return { node, chain };
}

const PLAIN_UNSAFE_RE = /[:#\[\]{},&*!|>'"%@`\n\r\t?]/;

function isPlainSafe(s: string): boolean {
  if (s === "" || s !== s.trim()) return false;
  if (PLAIN_UNSAFE_RE.test(s)) return false;
  if (s.startsWith("-") && (s.length === 1 || s[1] === " ")) return false;
  return parseScalar(s) === s;
}

export function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("cannot write non-finite number");
    return String(value);
  }
  if (typeof value === "string") return isPlainSafe(value) ? value : JSON.stringify(value);
  throw new TypeError(`unsupported scalar type: ${typeof value}`);
}

/**
 * Replace the scalar at `path`. Only the scalar's lexical span is touched.
 * A path that does not resolve to an existing node is a no-op.
 */
export function setByPath(doc: Document, path: Path, value: unknown): EditResult {
  const resolved = resolve(doc.root, path);
  if (!resolved) return { changed: false, text: doc.src, edits: [] };
  const node = resolved.node;
  if (node.kind !== "scalar") {
    throw new TypeError(`cannot set ${node.kind} at path ${path.join(".")}; target must be a scalar`);
  }
  const text = formatScalar(value);
  const [start, end] = node.valueRange;
  const insert = node.implicit ? " " + text : text;
  const edits: Edit[] = [{ start, end, insert }];
  return { changed: true, text: applyEdits(doc.src, edits), edits };
}

/** Index of the line starting exactly at `offset`. */
function lineIndexStartingAt(lines: Line[], offset: number): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.start === offset) return i;
  }
  return -1;
}

/** Index of the line ending exactly at `offset`. */
function lineIndexEndingAt(lines: Line[], offset: number): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.end === offset) return i;
  }
  return -1;
}

/** Contiguous full-line comments (indent >= itemIndent) directly after line `from`. */
function ownedTrailingComments(doc: Document, fromLine: number, itemIndent: number): Line[] {
  const out: Line[] = [];
  for (let i = fromLine + 1; i < doc.lines.length; i++) {
    const l = doc.lines[i]!;
    if (l.comment && l.indent >= itemIndent) out.push(l);
    else break;
  }
  return out;
}

/**
 * Delete the item at `path`. The item's lines are removed; its trailing
 * comment lines move to just after the previous surviving sibling item.
 * When there is no previous sibling the comments stay in place.
 * A path that does not resolve is a no-op.
 */
export function deleteByPath(doc: Document, path: Path): EditResult {
  if (path.length === 0) throw new TypeError("cannot delete the document root");
  const resolved = resolve(doc.root, path);
  if (!resolved) return { changed: false, text: doc.src, edits: [] };
  const slot = resolved.chain[resolved.chain.length - 1]!;
  const parent = slot.container;
  const idx = slot.index;

  // Locate the deleted item's lines and its previous surviving sibling.
  let firstLineStart: number;
  let nodeEnd: number;
  let inlineSoleKeyStart = -1; // >= 0 when blanking a sole `- key:` inline entry
  let inlineSoleEnd = -1;
  let prevSiblingEnd: number | null = null;
  let prevSiblingIndent = 0;

  if (parent.kind === "map") {
    const entry = parent.entries[idx]!;
    firstLineStart = entry.lineStart;
    nodeEnd = entry.node.range[1];
    const mapLine = doc.lines[lineIndexStartingAt(doc.lines, parent.range[0])]!;
    const inlineSeqMap = mapLine.body === "-" || mapLine.body.startsWith("- ");
    if (inlineSeqMap && parent.range[0] === entry.lineStart && idx === 0) {
      if (parent.entries.length > 1) {
        throw new TypeError(
          "cannot delete the first inline entry of a sequence-item map; delete the whole item instead",
        );
      }
      inlineSoleKeyStart = entry.keyRange[0];
      if (entry.node.kind === "scalar" && !entry.node.implicit) {
        // Keep the line's inline comment: blank only `key: value`.
        inlineSoleEnd = entry.node.valueRange[1];
      } else {
        inlineSoleEnd = nodeEnd;
        if (doc.src[inlineSoleEnd - 1] === "\n") inlineSoleEnd--;
      }
      const seqSlot = resolved.chain.length >= 2 ? resolved.chain[resolved.chain.length - 2]! : null;
      if (seqSlot && seqSlot.container.kind === "seq" && seqSlot.index > 0) {
        const sib = seqSlot.container.items[seqSlot.index - 1]!;
        prevSiblingEnd = sib.node.range[1];
        prevSiblingIndent = doc.lines[lineIndexStartingAt(doc.lines, sib.lineStart)]!.indent;
      }
    } else if (idx > 0) {
      const sib = parent.entries[idx - 1]!;
      prevSiblingEnd = sib.node.range[1];
      prevSiblingIndent = doc.lines[lineIndexStartingAt(doc.lines, sib.lineStart)]!.indent;
    }
  } else {
    const item = parent.items[idx]!;
    firstLineStart = item.lineStart;
    nodeEnd = item.node.range[1];
    if (idx > 0) {
      const sib = parent.items[idx - 1]!;
      prevSiblingEnd = sib.node.range[1];
      prevSiblingIndent = doc.lines[lineIndexStartingAt(doc.lines, sib.lineStart)]!.indent;
    }
  }

  const itemIndent = doc.lines[lineIndexStartingAt(doc.lines, firstLineStart)]!.indent;
  const owned = ownedTrailingComments(doc, lineIndexEndingAt(doc.lines, nodeEnd), itemIndent);
  const moveComments = prevSiblingEnd !== null && owned.length > 0;
  const commentText = moveComments ? doc.src.slice(owned[0]!.start, owned[owned.length - 1]!.end) : "";

  const edits: Edit[] = [];
  if (moveComments) {
    const sibLi = lineIndexEndingAt(doc.lines, prevSiblingEnd!);
    const sibOwned = ownedTrailingComments(doc, sibLi, prevSiblingIndent);
    const insertPos = sibOwned.length ? sibOwned[sibOwned.length - 1]!.end : prevSiblingEnd!;
    edits.push({ start: insertPos, end: insertPos, insert: commentText });
  }
  if (inlineSoleKeyStart >= 0) {
    // Blank `- key: ...` back to `-` (null item), keeping the line's newline.
    edits.push({ start: inlineSoleKeyStart, end: inlineSoleEnd, insert: "" });
    if (moveComments) {
      edits.push({ start: owned[0]!.start, end: owned[owned.length - 1]!.end, insert: "" });
    }
  } else {
    const removalEnd = moveComments ? owned[owned.length - 1]!.end : nodeEnd;
    edits.push({ start: firstLineStart, end: removalEnd, insert: "" });
  }
  return { changed: true, text: applyEdits(doc.src, edits), edits };
}
