import { CharId, Op, Site } from '../src/model';

/** Build a document one character at a time; returns the ops and char ids. */
export function buildDoc(site: Site, text: string): { ops: Op[]; ids: CharId[] } {
  const ops: Op[] = [];
  const ids: CharId[] = [];
  let after: CharId | null = null;
  for (const ch of text) {
    const op = site.insert(after, ch);
    ops.push(op);
    ids.push(op.id);
    after = op.id;
  }
  return { ops, ids };
}
