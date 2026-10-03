import { tokenize } from './tokenize.js';
import { encodePosting, decodePosting } from './posting.js';

function phraseMatch(positionLists) {
  const sets = positionLists.map((ps) => new Set(ps));
  for (const p0 of positionLists[0]) {
    let ok = true;
    for (let i = 1; i < positionLists.length; i++) {
      if (!sets[i].has(p0 + i)) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function nearMatch(positionLists, k) {
  // Sliding window over (position, termIndex): all terms present within span <= k.
  const all = [];
  positionLists.forEach((ps, termIdx) => {
    for (const p of ps) all.push([p, termIdx]);
  });
  all.sort((a, b) => a[0] - b[0]);
  const counts = new Array(positionLists.length).fill(0);
  let have = 0;
  let left = 0;
  for (let right = 0; right < all.length; right++) {
    if (counts[all[right][1]]++ === 0) have++;
    while (have === positionLists.length) {
      if (all[right][0] - all[left][0] <= k) return true;
      if (--counts[all[left][1]] === 0) have--;
      left++;
    }
  }
  return false;
}

// Positional inverted index over change-log notes. Posting lists are stored
// compressed (chunked bitset + varint) and decoded on demand.
export class SearchIndex {
  constructor() {
    this.docs = new Map(); // docId -> raw text
    this.compressed = new Map(); // term -> Uint8Array
  }

  add(docId, text) {
    this.docs.set(docId, String(text));
    this.rebuild();
  }

  remove(docId) {
    this.docs.delete(docId);
    this.rebuild();
  }

  rebuild() {
    const postings = new Map(); // term -> Map(docId -> positions[])
    for (const [docId, text] of this.docs) {
      tokenize(text).forEach((token, pos) => {
        if (!postings.has(token)) postings.set(token, new Map());
        const byDoc = postings.get(token);
        if (!byDoc.has(docId)) byDoc.set(docId, []);
        byDoc.get(docId).push(pos);
      });
    }
    this.compressed = new Map();
    for (const [term, byDoc] of postings) {
      this.compressed.set(term, encodePosting(byDoc));
    }
  }

  postingFor(term) {
    const buf = this.compressed.get(term);
    return buf ? decodePosting(buf) : new Map();
  }

  // terms: array of query tokens; near: null => exact phrase, k => proximity.
  search(terms, { near = null } = {}) {
    if (!terms.length) return [];
    const maps = terms.map((t) => this.postingFor(t));
    if (maps.some((m) => m.size === 0)) return [];
    let candidates = [...maps[0].keys()];
    for (const m of maps.slice(1)) candidates = candidates.filter((d) => m.has(d));
    const hits = [];
    for (const docId of candidates) {
      const lists = maps.map((m) => m.get(docId));
      const ok = near === null ? phraseMatch(lists) : nearMatch(lists, near);
      if (ok) hits.push(docId);
    }
    return hits.sort((a, b) => a - b);
  }
}
