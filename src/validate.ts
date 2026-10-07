import type { El } from "./tree.js";
import { walk } from "./tree.js";
import type { Index } from "./index.js";

/** Throws unless the index exactly mirrors the live tree rooted at root. */
export function validateIndex(root: El, index: Index): void {
  const nodes = [...walk(root)];
  const problems: string[] = [];

  if (index.all.size !== nodes.length) {
    problems.push(`all size ${index.all.size} != tree size ${nodes.length}`);
  }
  for (const el of nodes) {
    if (!index.all.has(el)) problems.push(`#${el.uid} missing from all`);
    if (!index.parent.has(el)) {
      problems.push(`#${el.uid} missing parent entry`);
    } else if (index.parent.get(el) !== el.parent) {
      problems.push(`#${el.uid} stale parent in index`);
    }
    const indexed = index.children.get(el);
    if (indexed === undefined) {
      problems.push(`#${el.uid} missing children entry`);
    } else if (indexed.length !== el.children.length || indexed.some((c, i) => c !== el.children[i])) {
      problems.push(`#${el.uid} stale children in index`);
    }
    if (!index.byTag.get(el.tag)?.has(el)) problems.push(`#${el.uid} missing from byTag`);
    for (const cls of el.classes) {
      if (!index.byClass.get(cls)?.has(el)) problems.push(`#${el.uid} missing from byClass ${cls}`);
    }
    for (const name of el.attrs.keys()) {
      if (!index.byAttr.get(name)?.has(el)) problems.push(`#${el.uid} missing from byAttr ${name}`);
    }
  }

  const inTree = new Set(nodes);
  for (const el of index.all) {
    if (!inTree.has(el)) problems.push(`detached #${el.uid} still in all`);
  }
  for (const el of index.parent.keys()) {
    if (!inTree.has(el)) problems.push(`detached #${el.uid} still has parent entry`);
  }
  for (const el of index.children.keys()) {
    if (!inTree.has(el)) problems.push(`detached #${el.uid} still has children entry`);
  }
  const checkLookup = (map: Map<string, Set<El>>, label: string): void => {
    for (const [key, set] of map) {
      for (const el of set) {
        if (!inTree.has(el)) problems.push(`detached #${el.uid} still in ${label} ${key}`);
      }
    }
  };
  checkLookup(index.byTag, "byTag");
  checkLookup(index.byClass, "byClass");
  checkLookup(index.byAttr, "byAttr");

  if (problems.length > 0) {
    throw new Error(`index out of sync:\n  ${problems.join("\n  ")}`);
  }
}
