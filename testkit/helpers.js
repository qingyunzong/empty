'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-idx-'));
}

// Independent tokenizer (separate implementation from src/store.js).
function tokenizeIndependent(text) {
  const out = [];
  let cur = '';
  for (const ch of String(text).toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(ch)) cur += ch;
    else if (cur) { out.push(cur); cur = ''; }
  }
  if (cur) out.push(cur);
  return out;
}

// Independent brute force: enumerate EVERY position tuple (cartesian product),
// keep strictly increasing tuples whose window slack (span - (k-1)) <= slop.
function bruteForceWindows(text, phrase, slop) {
  const docTerms = tokenizeIndependent(text);
  const phraseTerms = tokenizeIndependent(phrase);
  const posLists = phraseTerms.map((t) => {
    const list = [];
    docTerms.forEach((dt, i) => { if (dt === t) list.push(i); });
    return list;
  });
  if (posLists.some((l) => l.length === 0)) return [];
  const results = [];
  const tuple = [];
  function walk(i) {
    if (i === posLists.length) {
      let increasing = true;
      for (let j = 1; j < tuple.length; j++) if (tuple[j] <= tuple[j - 1]) increasing = false;
      if (increasing && (tuple[tuple.length - 1] - tuple[0]) - (tuple.length - 1) <= slop) {
        results.push(tuple.slice());
      }
      return;
    }
    for (const p of posLists[i]) { tuple[i] = p; walk(i + 1); }
  }
  walk(0);
  return results;
}

function normWindows(windows) {
  return windows.map((w) => w.join(',')).sort();
}

module.exports = { tmpdir, tokenizeIndependent, bruteForceWindows, normWindows };
