// Positional inverted index and query evaluation (phrase / unordered near).

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

export function tokenize(text) {
  const tokens = [];
  const re = new RegExp(TOKEN_RE.source, 'gu');
  let m;
  while ((m = re.exec(text)) !== null) tokens.push(m[0].toLowerCase());
  return tokens;
}

// docs: [{ key, text }] -> Map<term, Map<key, number[]>>
export function buildPositionalIndex(docs) {
  const index = new Map();
  for (const { key, text } of docs) {
    tokenize(text).forEach((term, pos) => {
      let postings = index.get(term);
      if (!postings) index.set(term, (postings = new Map()));
      let list = postings.get(key);
      if (!list) postings.set(key, (list = []));
      list.push(pos);
    });
  }
  return index;
}

function positionsWithin(tokens, terms, start, end) {
  const termSet = new Set(terms);
  const out = [];
  for (let p = start; p <= end && p < tokens.length; p++) {
    if (termSet.has(tokens[p])) out.push(p);
  }
  return out;
}

// Phrase hits inside one document given per-term sorted position lists.
export function phraseHitsInDoc(posLists, tokens, terms) {
  const n = posLists.length;
  const hits = [];
  const sets = posLists.map((l) => new Set(l));
  for (const p of posLists[0]) {
    let ok = true;
    for (let i = 1; i < n; i++) {
      if (!sets[i].has(p + i)) { ok = false; break; }
    }
    if (ok) {
      hits.push({
        start: p,
        end: p + n - 1,
        distance: n - 1,
        positions: positionsWithin(tokens, terms, p, p + n - 1),
      });
    }
  }
  return hits;
}

// Unordered near hits inside one document: enumerate every unordered
// window, i.e. every combination of one occurrence per query term; the
// window spans [min, max] and matches when (max - min) - (n - 1) <= slop.
// Windows are deduplicated by their span.
export function nearHitsInDoc(posLists, slop, tokens, terms) {
  const n = posLists.length;
  const limit = slop + n - 1;
  const hits = [];
  const seen = new Set();
  const combo = new Array(n);
  const visit = (i) => {
    if (i === n) {
      let start = combo[0];
      let end = combo[0];
      for (const p of combo) {
        if (p < start) start = p;
        if (p > end) end = p;
      }
      if (end - start > limit) return;
      const key = start + ':' + end;
      if (seen.has(key)) return;
      seen.add(key);
      hits.push({
        start,
        end,
        distance: end - start,
        positions: positionsWithin(tokens, terms, start, end),
      });
      return;
    }
    for (const p of posLists[i]) {
      combo[i] = p;
      visit(i + 1);
    }
  };
  visit(0);
  return hits;
}

// Deterministic hit ordering: word distance asc, evidence id asc, then span.
export function compareHits(a, b) {
  if (a.distance !== b.distance) return a.distance - b.distance;
  if (a.evidenceId !== b.evidenceId) return a.evidenceId < b.evidenceId ? -1 : 1;
  if (a.start !== b.start) return a.start - b.start;
  return a.end - b.end;
}

// query: { type: 'phrase'|'near', terms: string[], slop?: number }
// docs:  [{ key, revision, text }]
export function searchDocs(docs, query) {
  const terms = query.terms.map((t) => t.toLowerCase());
  if (terms.length === 0) return [];
  const slop = query.type === 'near' ? (query.slop ?? 0) : 0;
  const index = buildPositionalIndex(docs.map((d) => ({ key: d.key, text: d.text })));
  const tokensByKey = new Map(docs.map((d) => [d.key, tokenize(d.text)]));
  const hits = [];
  for (const d of docs) {
    const posLists = terms.map((t) => index.get(t)?.get(d.key));
    if (posLists.some((l) => l === undefined)) continue;
    const tokens = tokensByKey.get(d.key);
    const docHits = query.type === 'phrase'
      ? phraseHitsInDoc(posLists, tokens, terms)
      : nearHitsInDoc(posLists, slop, tokens, terms);
    for (const h of docHits) {
      hits.push({ evidenceId: d.key, revision: d.revision, ...h });
    }
  }
  hits.sort(compareHits);
  return hits;
}
