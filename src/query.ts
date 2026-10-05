/**
 * Query engine: a full-scan reference implementation and an
 * incrementally-maintained index implementation.
 *
 * The index stores only per-element features (tag / classes / attribute
 * names). Parent-child relations are NEVER cached in the index: combinator
 * checks walk the live tree, so a move/insert/delete can never leave stale
 * parent relations behind. Subtree mutations update index membership via
 * tree events.
 */

import { El, walk, type TreeEvent } from "./tree.js";
import {
  nthMatches,
  parseSelectorList,
  type Complex,
  type Compound,
  type SelectorList,
} from "./selector.js";

export function matchesCompound(el: El, c: Compound): boolean {
  if (c.tag !== null && el.tag !== c.tag) return false;
  for (const cls of c.classes) {
    if (!el.classes.has(cls)) return false;
  }
  for (const cond of c.attrs) {
    const v = el.attrs.get(cond.name);
    if (v === undefined) return false;
    if (cond.value !== null && v !== cond.value) return false;
  }
  if (c.nth !== null && !nthMatches(el.siblingIndex(), c.nth)) return false;
  return true;
}

function matchesAt(el: El, cx: Complex, i: number): boolean {
  const compound = cx.compounds[i]!;
  if (!matchesCompound(el, compound)) return false;
  if (i === 0) return true;
  const comb = cx.combinators[i - 1]!;
  if (comb === "child") {
    return el.parent !== null && matchesAt(el.parent, cx, i - 1);
  }
  let anc = el.parent;
  while (anc !== null) {
    if (matchesAt(anc, cx, i - 1)) return true;
    anc = anc.parent;
  }
  return false;
}

export function matchesComplex(el: El, cx: Complex): boolean {
  return matchesAt(el, cx, cx.compounds.length - 1);
}

export function matchesAny(el: El, list: SelectorList): boolean {
  return list.some((cx) => matchesComplex(el, cx));
}

/** Reference implementation: full tree scan, document order, no index. */
export function scanQuery(root: El, selector: string): El[] {
  const list = parseSelectorList(selector);
  const out: El[] = [];
  for (const el of walk(root)) {
    if (matchesAny(el, list)) out.push(el);
  }
  return out;
}

interface IndexedFeatures {
  tag: string;
  classes: string[];
  attrs: string[];
}

export class DomIndex {
  private readonly byTag = new Map<string, Set<El>>();
  private readonly byClass = new Map<string, Set<El>>();
  private readonly byAttr = new Map<string, Set<El>>();
  private readonly all = new Set<El>();
  /** What we indexed per element, so re-indexing after a change removes the OLD keys. */
  private readonly indexed = new Map<El, IndexedFeatures>();
  private readonly detachListener: () => void;

  constructor(readonly root: El) {
    for (const el of walk(root)) this.add(el);
    this.detachListener = root.on((e) => this.handle(e));
  }

  dispose(): void {
    this.detachListener();
  }

  get size(): number {
    return this.all.size;
  }

  private handle(e: TreeEvent): void {
    if (e.type === "inserted") {
      for (const el of walk(e.node)) this.add(el);
    } else if (e.type === "removed") {
      for (const el of walk(e.node)) this.remove(el);
    } else {
      this.remove(e.node);
      this.add(e.node);
    }
  }

  private add(el: El): void {
    if (this.indexed.has(el)) return;
    const features: IndexedFeatures = {
      tag: el.tag,
      classes: [...el.classes],
      attrs: [...el.attrs.keys()],
    };
    this.indexed.set(el, features);
    this.all.add(el);
    DomIndex.put(this.byTag, features.tag, el);
    for (const c of features.classes) DomIndex.put(this.byClass, c, el);
    for (const a of features.attrs) DomIndex.put(this.byAttr, a, el);
  }

  private remove(el: El): void {
    const features = this.indexed.get(el);
    if (features === undefined) return;
    this.indexed.delete(el);
    this.all.delete(el);
    DomIndex.del(this.byTag, features.tag, el);
    for (const c of features.classes) DomIndex.del(this.byClass, c, el);
    for (const a of features.attrs) DomIndex.del(this.byAttr, a, el);
  }

  private static put(map: Map<string, Set<El>>, key: string, el: El): void {
    let set = map.get(key);
    if (set === undefined) {
      set = new Set();
      map.set(key, set);
    }
    set.add(el);
  }

  private static del(map: Map<string, Set<El>>, key: string, el: El): void {
    const set = map.get(key);
    if (set === undefined) return;
    set.delete(el);
    if (set.size === 0) map.delete(key);
  }

  /** Smallest available candidate set for a compound, or the whole tree. */
  candidates(c: Compound): readonly El[] {
    let best: Set<El> | undefined;
    const consider = (set: Set<El> | undefined): void => {
      if (set !== undefined && (best === undefined || set.size < best.size)) {
        best = set;
      }
    };
    if (c.tag !== null) consider(this.byTag.get(c.tag));
    for (const cls of c.classes) consider(this.byClass.get(cls));
    for (const cond of c.attrs) consider(this.byAttr.get(cond.name));
    const picked: Set<El> = best !== undefined ? best : this.all;
    return [...picked];
  }
}

/**
 * Indexed query. Candidates come from the index; full matching (including
 * combinators and :nth-child) is verified against the live tree. Results of
 * a selector list are deduplicated and returned in document order.
 */
export function indexedQuery(root: El, index: DomIndex, selector: string): El[] {
  const list = parseSelectorList(selector);
  const matched = new Set<El>();
  for (const cx of list) {
    const rightmost = cx.compounds[cx.compounds.length - 1]!;
    for (const el of index.candidates(rightmost)) {
      if (matchesComplex(el, cx)) matched.add(el);
    }
  }
  const out: El[] = [];
  for (const el of walk(root)) {
    if (matched.has(el)) out.push(el);
  }
  return out;
}
