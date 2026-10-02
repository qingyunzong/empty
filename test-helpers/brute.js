import { tokenize, compileTerm } from '../src/tokenize.js';

// Independent brute-force reference: scans each document's token stream
// directly. Used to cross-check the inverted index query results.

export function bruteOccurrences(tokens, seq) {
  const starts = [];
  for (let i = 0; i + seq.length <= tokens.length; i += 1) {
    let ok = true;
    for (let j = 0; j < seq.length; j += 1) {
      if (tokens[i + j].term !== seq[j]) {
        ok = false;
        break;
      }
    }
    if (ok) starts.push(tokens[i].pos);
  }
  return starts;
}

export function brutePhrase(docs, phrase) {
  const seq = phrase.trim().split(/\s+/).filter(Boolean).flatMap((p) => compileTerm(p));
  const rows = [];
  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    const starts = bruteOccurrences(tokens, seq);
    if (starts.length > 0) {
      rows.push({ id: doc.id, version: doc.version, matches: starts.map((s) => [s, s + seq.length - 1]) });
    }
  }
  return sortRows(rows);
}

export function bruteTerm(docs, term) {
  const seq = compileTerm(term);
  const rows = [];
  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    const starts = bruteOccurrences(tokens, seq);
    if (starts.length > 0) {
      rows.push({ id: doc.id, version: doc.version, matches: starts.map((s) => [s, s + seq.length - 1]) });
    }
  }
  return sortRows(rows);
}

export function bruteNear(docs, left, right, k) {
  const seqA = compileTerm(left);
  const seqB = compileTerm(right);
  const rows = [];
  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    const startsA = bruteOccurrences(tokens, seqA);
    const startsB = bruteOccurrences(tokens, seqB);
    const pairs = [];
    for (const sa of startsA) {
      const ea = sa + seqA.length - 1;
      for (const sb of startsB) {
        const eb = sb + seqB.length - 1;
        let gap;
        if (sb > ea) gap = sb - ea - 1;
        else if (sa > eb) gap = sa - eb - 1;
        else gap = 0;
        if (gap <= k) pairs.push([sa, ea, sb, eb]);
      }
    }
    if (pairs.length > 0) {
      pairs.sort((a, b) => {
        for (let i = 0; i < 4; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
        return 0;
      });
      rows.push({ id: doc.id, version: doc.version, matches: pairs });
    }
  }
  return sortRows(rows);
}

function sortRows(rows) {
  rows.sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return a.version - b.version;
  });
  return rows;
}
