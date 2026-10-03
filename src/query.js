// Positional text index and query evaluation (phrase + unordered near).

export function tokenize(text) {
  const tokens = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m;
  const lower = String(text).toLowerCase();
  while ((m = re.exec(lower)) !== null) tokens.push(m[0]);
  return tokens;
}

// Build a positional index: Map<term, Array<{docIndex, position}>>
export function buildPositionalIndex(documents) {
  const index = new Map();
  documents.forEach((doc, docIndex) => {
    tokenize(doc.text).forEach((term, position) => {
      let postings = index.get(term);
      if (!postings) {
        postings = [];
        index.set(term, postings);
      }
      postings.push({ docIndex, position });
    });
  });
  return index;
}

export function compareIds(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// Phrase query: exact consecutive term sequence.
// Returns hits sorted by evidence id asc, then start position asc (deterministic).
export function phraseHits(documents, phrase) {
  const terms = tokenize(phrase);
  if (terms.length === 0) return [];
  const hits = [];
  documents.forEach((doc, docIndex) => {
    const tokens = tokenize(doc.text);
    for (let start = 0; start + terms.length <= tokens.length; start++) {
      let ok = true;
      for (let j = 0; j < terms.length; j++) {
        if (tokens[start + j] !== terms[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        hits.push({
          evidenceId: doc.id,
          revision: doc.revision,
          positions: terms.map((_, j) => start + j),
        });
      }
    }
  });
  hits.sort(
    (a, b) => compareIds(a.evidenceId, b.evidenceId) || a.positions[0] - b.positions[0],
  );
  return hits;
}

// Minimal window [lo, hi] covering every distinct query term at least once.
// Tie-break: smallest span, then smallest lo. Returns null when uncovered.
function minimalWindow(tokens, termSet, need) {
  const occ = [];
  tokens.forEach((token, pos) => {
    if (termSet.has(token)) occ.push([pos, token]);
  });
  let best = null;
  const count = new Map();
  let have = 0;
  let left = 0;
  for (let right = 0; right < occ.length; right++) {
    const rt = occ[right][1];
    if (!count.get(rt)) have++;
    count.set(rt, (count.get(rt) || 0) + 1);
    while (have === need) {
      const lo = occ[left][0];
      const hi = occ[right][0];
      const span = hi - lo;
      if (!best || span < best.span || (span === best.span && lo < best.lo)) {
        best = { lo, hi, span };
      }
      const lt = occ[left][1];
      count.set(lt, count.get(lt) - 1);
      if (!count.get(lt)) have--;
      left++;
    }
  }
  return best;
}

// Unordered near query: terms may appear in any order inside a window whose
// span (hi - lo) is at most (distinctTerms - 1) + slop.
// Hits sorted by word distance asc, then evidence id asc (deterministic).
export function nearHits(documents, query, slop = 0) {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  if (!Number.isInteger(slop) || slop < 0) {
    throw new Error(`invalid slop: ${slop}`);
  }
  const maxSpan = terms.length - 1 + slop;
  const termSet = new Set(terms);
  const hits = [];
  for (const doc of documents) {
    const tokens = tokenize(doc.text);
    const win = minimalWindow(tokens, termSet, terms.length);
    if (!win || win.span > maxSpan) continue;
    const positions = [];
    for (const term of terms) {
      for (let p = win.lo; p <= win.hi; p++) {
        if (tokens[p] === term) {
          positions.push(p);
          break;
        }
      }
    }
    hits.push({
      evidenceId: doc.id,
      revision: doc.revision,
      distance: win.span,
      window: [win.lo, win.hi],
      positions,
    });
  }
  hits.sort((a, b) => a.distance - b.distance || compareIds(a.evidenceId, b.evidenceId));
  return hits;
}

// Dispatch a query spec: { phrase } or { near, slop }.
export function runQuery(documents, query) {
  if (query && typeof query.phrase === 'string') {
    return { type: 'phrase', hits: phraseHits(documents, query.phrase) };
  }
  if (query && typeof query.near === 'string') {
    return { type: 'near', hits: nearHits(documents, query.near, query.slop ?? 0) };
  }
  throw new Error('query must specify "phrase" or "near"');
}
