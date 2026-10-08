import { Document, OpId } from "../src/index.js";

export function docWithText(
  site: string,
  text: string,
): { doc: Document; ids: OpId[] } {
  const doc = new Document(site);
  const ids: OpId[] = [];
  let parent: OpId | null = null;
  for (const char of text) {
    const op = doc.insert(parent, char);
    ids.push(op.id);
    parent = op.id;
  }
  return { doc, ids };
}
