import { Document } from "./document.js";
import { OpId, sameOpId, formatOpId } from "./ids.js";

export type Anchor = { type: "char"; id: OpId } | { type: "end" };

export interface Selection {
  anchor: Anchor;
  head: Anchor;
}

export interface ResolvedSelection {
  start: number;
  end: number;
}

export function caretAnchor(doc: Document, offset: number): Anchor {
  const visible = doc.visibleEntries();
  if (offset < 0 || offset > visible.length) {
    throw new RangeError(`offset ${offset} out of range 0..${visible.length}`);
  }
  if (offset === visible.length) return { type: "end" };
  return { type: "char", id: visible[offset].id };
}

export function rangeSelection(
  doc: Document,
  start: number,
  end: number,
): Selection {
  return { anchor: caretAnchor(doc, start), head: caretAnchor(doc, end) };
}

export function resolveAnchor(doc: Document, anchor: Anchor): number {
  const entries = doc.entries();
  if (anchor.type === "end") {
    return entries.filter((entry) => !entry.deleted).length;
  }
  const index = entries.findIndex((entry) => sameOpId(entry.id, anchor.id));
  if (index === -1) {
    throw new Error(`unknown anchor ${formatOpId(anchor.id)}`);
  }
  let visibleBefore = 0;
  for (let i = 0; i < entries.length; i++) {
    if (i >= index && !entries[i].deleted) return visibleBefore;
    if (!entries[i].deleted) visibleBefore += 1;
  }
  return visibleBefore;
}

export function resolveSelection(
  doc: Document,
  selection: Selection,
): ResolvedSelection {
  const a = resolveAnchor(doc, selection.anchor);
  const b = resolveAnchor(doc, selection.head);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

export function selectedText(doc: Document, selection: Selection): string {
  const { start, end } = resolveSelection(doc, selection);
  return doc
    .visibleEntries()
    .slice(start, end)
    .map((entry) => entry.char)
    .join("");
}
