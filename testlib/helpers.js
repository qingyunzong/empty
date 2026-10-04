import { tokenize } from '../src/posindex.js';

// Brute-force phrase match over raw text: consecutive token positions.
export function brutePhrase(text, phrase) {
  const tokens = tokenize(text);
  const terms = tokenize(phrase);
  if (terms.length === 0 || tokens.length < terms.length) return null;
  const positions = [];
  for (let i = 0; i + terms.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < terms.length; j++) {
      if (tokens[i + j] !== terms[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      for (let j = 0; j < terms.length; j++) positions.push(i + j);
    }
  }
  return positions.length > 0 ? positions : null;
}

// Brute-force proximity match: first window of k consecutive positions
// (enumerated from 0) that contains every distinct query term.
export function bruteNear(text, query, k) {
  const tokens = tokenize(text);
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || k < terms.length) return null;
  for (let start = 0; start < tokens.length; start++) {
    const end = Math.min(start + k, tokens.length);
    const window = new Set(tokens.slice(start, end));
    if (terms.every((t) => window.has(t))) {
      const positions = [];
      for (let i = start; i < end; i++) {
        if (terms.includes(tokens[i])) positions.push(i);
      }
      return positions;
    }
  }
  return null;
}

export function brutePhraseAll(docs, phrase) {
  const out = [];
  for (const [nodeId, text] of docs) {
    const positions = brutePhrase(text, phrase);
    if (positions) out.push({ nodeId, positions });
  }
  return out.sort((a, b) => String(a.nodeId).localeCompare(String(b.nodeId)));
}

export function bruteNearAll(docs, query, k) {
  const out = [];
  for (const [nodeId, text] of docs) {
    const positions = bruteNear(text, query, k);
    if (positions) out.push({ nodeId, positions });
  }
  return out.sort((a, b) => String(a.nodeId).localeCompare(String(b.nodeId)));
}
