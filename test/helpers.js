import { tokenize, sameParagraph } from '../src/tokenize.js';

// Independent reference: brute-force per-word enumeration over raw documents.
// Shares only the tokenizer with the index; matching/ranking logic is separate.
export function referenceQuery(corpus, deletedIds, parsed) {
  const results = [];
  for (const doc of corpus) {
    if (deletedIds.has(doc.id)) continue;
    const { tokens, paragraphs } = tokenize(doc.text);
    let hits = 0;
    let minSpan = Infinity;
    if (parsed.type === 'term') {
      for (const t of tokens) if (t === parsed.term) hits += 1;
      if (hits) minSpan = 1;
    } else if (parsed.type === 'phrase') {
      const n = parsed.tokens.length;
      for (let i = 0; i + n <= tokens.length; i += 1) {
        let ok = true;
        for (let j = 0; j < n; j += 1) {
          if (tokens[i + j] !== parsed.tokens[j]) { ok = false; break; }
        }
        if (ok && sameParagraph(paragraphs, i, i + n - 1)) {
          hits += 1;
          if (n < minSpan) minSpan = n;
        }
      }
    } else { // near
      const posA = [];
      const posB = [];
      tokens.forEach((t, i) => {
        if (t === parsed.a) posA.push(i);
        if (t === parsed.b) posB.push(i);
      });
      for (const pa of posA) {
        for (const pb of posB) {
          if (pa === pb) continue;
          const dist = Math.abs(pa - pb);
          if (dist - 1 > parsed.k) continue;
          if (!sameParagraph(paragraphs, Math.min(pa, pb), Math.max(pa, pb))) continue;
          hits += 1;
          if (dist + 1 < minSpan) minSpan = dist + 1;
        }
      }
    }
    if (hits > 0) results.push({ docId: doc.id, hits, minSpan });
  }
  results.sort(
    (x, y) =>
      y.hits - x.hits ||
      x.minSpan - y.minSpan ||
      (x.docId < y.docId ? -1 : x.docId > y.docId ? 1 : 0),
  );
  return results;
}

export const CORPUS = [
  { id: 'm1', text: '泵 气蚀 原因码C101 处理码T201\n\n第二段 泵 正常运转 无气蚀' },
  { id: 'm2', text: '报警手册 泵 气蚀 气蚀 原因码C102 f1 f2 处理码T202' },
  { id: 'm3', text: '完全无关的条目 pump running normal' },
  { id: 'm4', text: '原因码C103 f1 f2 f3 f4 处理码T203 泵' },
  { id: 'm5', text: '泵\n\n气蚀 跨段不应命中' },
  { id: 'm6', text: '处理码T204 原因码C104' },
  { id: 'm7', text: '泵 气蚀 泵 气蚀 重复命中' },
];
