import { tokenize, queryTerms } from '../src/tokenize.js';

// Naive per-word enumeration reference: scans every token of every doc.
export function referenceQuery(docs, { phrase = null, near = null, k = 4 }) {
  const phraseTerms = phrase ? queryTerms(phrase) : null;
  const nearPair = near ? [queryTerms(near[0])[0], queryTerms(near[1])[0]] : null;
  const results = [];
  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    let phraseHits = 0;
    const phraseSpans = [];
    if (phraseTerms) {
      const n = phraseTerms.length;
      for (let i = 0; i + n <= tokens.length; i++) {
        let ok = true;
        for (let j = 0; j < n; j++) {
          if (tokens[i + j].term !== phraseTerms[j] || tokens[i + j].para !== tokens[i].para) {
            ok = false;
            break;
          }
        }
        // also require positions consecutive (they are, within a paragraph scan)
        if (ok) {
          let consec = true;
          for (let j = 1; j < n; j++) {
            if (tokens[i + j].pos !== tokens[i].pos + j) consec = false;
          }
          if (consec) {
            phraseHits++;
            phraseSpans.push({ start: tokens[i].pos, end: tokens[i].pos + n - 1 });
          }
        }
      }
    }
    const pairs = [];
    if (nearPair) {
      const aPos = tokens.filter((t) => t.term === nearPair[0]);
      const bPos = tokens.filter((t) => t.term === nearPair[1]);
      for (const a of aPos) {
        for (const b of bPos) {
          if (a.para === b.para && Math.abs(a.pos - b.pos) - 1 <= k) {
            pairs.push({ start: Math.min(a.pos, b.pos), end: Math.max(a.pos, b.pos) });
          }
        }
      }
    }
    if (phraseTerms && phraseHits === 0) continue;
    if (nearPair && pairs.length === 0) continue;
    const spans = [];
    if (phraseTerms && nearPair) {
      for (const s of phraseSpans) for (const p of pairs) spans.push(Math.max(s.end, p.end) - Math.min(s.start, p.start) + 1);
    } else if (phraseTerms) {
      for (const s of phraseSpans) spans.push(s.end - s.start + 1);
    } else {
      for (const p of pairs) spans.push(p.end - p.start + 1);
    }
    results.push({
      docID: doc.docID,
      phraseHits,
      nearHits: pairs.length,
      minSpan: spans.length ? Math.min(...spans) : 0,
    });
  }
  results.sort((a, b) => b.phraseHits - a.phraseHits || a.minSpan - b.minSpan || a.docID - b.docID);
  return results;
}

// Deterministic PRNG (mulberry32).
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = [
  '泵', '气蚀', '原因码', '处理码', 'c01', 'c02', 'a07', 'a09',
  '压力', '流量', '温度', '阀门', '检查', '入口', '出口', '报警',
];

export function makeCorpus(seed, nDocs) {
  const rand = rng(seed);
  const docs = [];
  for (let d = 0; d < nDocs; d++) {
    const nPara = 1 + Math.floor(rand() * 3);
    const paras = [];
    for (let p = 0; p < nPara; p++) {
      const len = 3 + Math.floor(rand() * 20);
      const words = [];
      for (let i = 0; i < len; i++) words.push(VOCAB[Math.floor(rand() * VOCAB.length)]);
      paras.push(words.join(' '));
    }
    docs.push({ docID: d + 1, ext: `D${d + 1}`, text: paras.join('\n\n') });
  }
  return docs;
}
