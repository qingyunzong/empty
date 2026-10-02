// Positional inverted index over event text. Supports phrase queries and
// unordered proximity (near) queries. Deletions are tombstones: entries stay
// in the index but are filtered at query time until compact() runs.

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

export function tokenize(text) {
  const tokens = [];
  if (typeof text !== 'string') return tokens;
  const re = new RegExp(TOKEN_RE.source, 'gu');
  let m;
  while ((m = re.exec(text)) !== null) tokens.push(m[0].toLowerCase());
  return tokens;
}

// Smallest span (max(pos)-min(pos)) covering at least one position of every
// token list. Returns Infinity when any list is empty.
function minCoveringSpan(positionLists) {
  const merged = [];
  positionLists.forEach((list, tag) => {
    for (const pos of list) merged.push([pos, tag]);
  });
  merged.sort((a, b) => a[0] - b[0]);
  const need = positionLists.length;
  const count = new Array(positionLists.length).fill(0);
  let have = 0;
  let best = Infinity;
  let left = 0;
  for (let right = 0; right < merged.length; right++) {
    const tag = merged[right][1];
    if (count[tag] === 0) have++;
    count[tag]++;
    while (have === need) {
      best = Math.min(best, merged[right][0] - merged[left][0]);
      const ltag = merged[left][1];
      count[ltag]--;
      if (count[ltag] === 0) have--;
      left++;
    }
  }
  return best;
}

export class TextIndex {
  constructor() {
    this.postings = new Map(); // term -> Map<docId, number[]>
    this.docs = new Map();     // docId -> tokens[]
    this.order = [];           // docIds in insertion order
    this.deleted = new Set();  // tombstoned docIds
  }

  add(id, text) {
    if (this.docs.has(id)) return;
    const tokens = tokenize(text);
    this.docs.set(id, tokens);
    this.order.push(id);
    tokens.forEach((term, pos) => {
      let byDoc = this.postings.get(term);
      if (!byDoc) {
        byDoc = new Map();
        this.postings.set(term, byDoc);
      }
      let positions = byDoc.get(id);
      if (!positions) {
        positions = [];
        byDoc.set(id, positions);
      }
      positions.push(pos);
    });
  }

  // Tombstone only; physical removal happens in compact().
  remove(id) {
    if (this.docs.has(id)) this.deleted.add(id);
  }

  compact() {
    for (const id of this.deleted) {
      const tokens = this.docs.get(id);
      if (tokens) {
        for (const term of new Set(tokens)) {
          const byDoc = this.postings.get(term);
          if (byDoc) {
            byDoc.delete(id);
            if (byDoc.size === 0) this.postings.delete(term);
          }
        }
      }
      this.docs.delete(id);
    }
    this.order = this.order.filter((id) => !this.deleted.has(id));
    this.deleted.clear();
  }

  // Live doc ids containing every term, in insertion order.
  _candidates(terms) {
    if (terms.length === 0) return [];
    const lists = terms.map((t) => this.postings.get(t));
    if (lists.some((m) => !m)) return [];
    return this.order.filter(
      (id) => !this.deleted.has(id) && lists.every((m) => m.has(id)),
    );
  }

  phraseQuery(phrase) {
    const terms = tokenize(phrase);
    if (terms.length === 0) return [];
    const out = [];
    for (const id of this._candidates(terms)) {
      const starts = this.postings.get(terms[0]).get(id);
      const rest = terms.slice(1).map((t) => new Set(this.postings.get(t).get(id)));
      if (starts.some((p) => rest.every((set, k) => set.has(p + k + 1)))) {
        out.push(id);
      }
    }
    return out;
  }

  // Unordered proximity: true when some window of `window` positions
  // (max-min <= window) contains every term at least once.
  nearQuery(terms, window) {
    const norm = terms.map((t) => String(t).toLowerCase());
    if (norm.length === 0) return [];
    const out = [];
    for (const id of this._candidates(norm)) {
      const lists = norm.map((t) => this.postings.get(t).get(id));
      if (minCoveringSpan(lists) <= window) out.push(id);
    }
    return out;
  }
}
