'use strict';
// Text/code normalization, tokenizer, edit-distance helpers.

export function normalizeText(s) {
  return String(s).normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

const CJK = /[㐀-䶿一-鿿豈-﫿]/u;

// CJK chars are individual tokens; latin/digit runs are tokens. Positions are
// token indexes in the stream, so phrases match on consecutive positions.
export function tokenize(s) {
  const text = normalizeText(s);
  const tokens = [];
  let pos = 0;
  let buf = '';
  const flush = () => {
    if (buf) {
      tokens.push({ term: buf, pos: pos++ });
      buf = '';
    }
  };
  for (const ch of text) {
    if (CJK.test(ch)) {
      flush();
      tokens.push({ term: ch, pos: pos++ });
    } else if (/[a-z0-9]/.test(ch)) {
      buf += ch;
    } else {
      flush();
    }
  }
  flush();
  return tokens;
}

export function normalizeCode(s) {
  return String(s).normalize('NFKC').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

// The string itself plus every single-char deletion (deduped).
export function deletions(s) {
  const out = new Set([s]);
  for (let i = 0; i < s.length; i++) out.add(s.slice(0, i) + s.slice(i + 1));
  return [...out];
}

export function editDistanceLE1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++; j++;
    } else {
      edits++;
      if (edits > 1) return false;
      if (la === lb) { i++; j++; }
      else if (la > lb) i++;
      else j++;
    }
  }
  if (i < la || j < lb) edits++;
  return edits <= 1;
}

// Canonical query form used for hashing and idempotency.
export function normalizeQuery(q) {
  const phraseTokens = q && q.phrase ? tokenize(q.phrase).map((t) => t.term) : [];
  const defectCode = q && q.defectCode ? normalizeCode(q.defectCode) : '';
  const batchCode = q && q.batchCode ? normalizeCode(q.batchCode) : '';
  const pub = {
    batchCode: batchCode || null,
    defectCode: defectCode || null,
    phrase: phraseTokens.length ? phraseTokens.join(' ') : null,
  };
  return { phraseTokens, defectCode, batchCode, public: pub };
}

export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
