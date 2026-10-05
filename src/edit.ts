import { AnyNode, Document, MapNode, ScalarNode, SeqNode, parse, typePlain } from './parser';

export type Path = ReadonlyArray<string | number>;

const PLAIN_SAFE = /^[A-Za-z0-9_.\-/]+$/;

/** Serialize a JS scalar to a YAML token that reparses to the same value. */
export function serializeScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite numbers are not supported');
    return String(value);
  }
  if (typeof value === 'string') {
    if (value.length > 0 && PLAIN_SAFE.test(value) && typePlain(value) === value) {
      return value;
    }
    return JSON.stringify(value);
  }
  throw new Error(`unsupported scalar type: ${typeof value}`);
}

export function toJS(node: AnyNode): unknown {
  switch (node.kind) {
    case 'scalar':
      return node.value;
    case 'seq':
      return node.items.map((item) => toJS(item.value));
    case 'map': {
      const out: Record<string, unknown> = {};
      for (const entry of node.entries) out[entry.key] = toJS(entry.value);
      return out;
    }
  }
}

/** Resolve a path to a node, or null when any segment is missing. */
export function getNode(doc: Document, path: Path): AnyNode | null {
  let cur: AnyNode = doc.root;
  for (const seg of path) {
    if (cur.kind === 'map') {
      if (typeof seg !== 'string') return null;
      const entry = cur.entries.find((e) => e.key === seg);
      if (!entry) return null;
      cur = entry.value;
    } else if (cur.kind === 'seq') {
      if (typeof seg !== 'number' || !Number.isInteger(seg) || seg < 0 || seg >= cur.items.length) {
        return null;
      }
      cur = cur.items[seg].value;
    } else {
      return null;
    }
  }
  return cur;
}

export function formatPath(path: Path): string {
  if (path.length === 0) return '<root>';
  return path.map((s) => (typeof s === 'number' ? `[${s}]` : `.${s}`)).join('');
}

export function getValue(text: string, path: Path): unknown {
  const node = getNode(parse(text), path);
  return node === null ? undefined : toJS(node);
}

/**
 * Replace the scalar at `path` with `value`, touching only the scalar's
 * lexical span. Returns the input unchanged when the path does not exist.
 * Throws when the path resolves to a non-scalar node.
 */
export function setScalar(text: string, path: Path, value: unknown): string {
  const doc = parse(text);
  const node = getNode(doc, path);
  if (node === null) return text;
  if (node.kind !== 'scalar') {
    throw new Error(`cannot set scalar at ${formatPath(path)}: target is a ${node.kind}`);
  }
  return applySet(text, node, value);
}

function applySet(text: string, node: ScalarNode, value: unknown): string {
  const serialized = serializeScalar(value);
  const { start, end } = node.span;
  if (start === end) {
    // Empty value (`key:` or `-`): insert after the indicator with a space.
    return text.slice(0, start) + ' ' + serialized + text.slice(end);
  }
  return text.slice(0, start) + serialized + text.slice(end);
}

interface LocatedItem {
  startLine: number;
  endLine: number;
  /** Last content line of the previous surviving sibling, or -1. */
  prevEndLine: number;
}

function locateItem(container: AnyNode | null, seg: string | number): LocatedItem | null {
  if (container !== null && container.kind === 'map' && typeof seg === 'string') {
    const map: MapNode = container;
    const idx = map.entries.findIndex((e) => e.key === seg);
    if (idx === -1) return null;
    const entry = map.entries[idx];
    return {
      startLine: entry.startLine,
      endLine: entry.endLine,
      prevEndLine: idx > 0 ? map.entries[idx - 1].endLine : -1,
    };
  }
  if (container !== null && container.kind === 'seq' && typeof seg === 'number') {
    const seq: SeqNode = container;
    if (!Number.isInteger(seg) || seg < 0 || seg >= seq.items.length) return null;
    const item = seq.items[seg];
    return {
      startLine: item.startLine,
      endLine: item.endLine,
      prevEndLine: seg > 0 ? seq.items[seg - 1].endLine : -1,
    };
  }
  return null;
}

/**
 * Delete the item at `path`, removing exactly its own lines. A trailing
 * comment on the deleted item's first line is moved to the last content
 * line of the previous surviving sibling (dropped when there is none).
 * Returns the input unchanged when the path does not exist.
 */
export function deleteItem(text: string, path: Path): string {
  if (path.length === 0) return text;
  const doc = parse(text);
  const parent = getNode(doc, path.slice(0, -1));
  const located = locateItem(parent, path[path.length - 1]);
  if (located === null) return text;

  const lines = doc.lines;
  const firstLine = lines[located.startLine];
  let comment: string | null = null;
  if (firstLine.commentStart !== -1) {
    comment = text.slice(firstLine.commentStart, firstLine.end);
  }

  const delStart = lines[located.startLine].start;
  const delEnd = lines[located.endLine].next;
  let result = text.slice(0, delStart) + text.slice(delEnd);

  if (comment !== null && located.prevEndLine !== -1) {
    // prevEndLine always precedes delStart, so splicing after deletion is safe.
    const insertAt = lines[located.prevEndLine].end;
    result = result.slice(0, insertAt) + '  ' + comment + result.slice(insertAt);
  }
  return result;
}
