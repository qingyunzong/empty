'use strict';

const { ALPHABET, TOKEN_INDEX } = require('./tokens');
const { unionNFA, determinize, toCompleteTable, minimizeDFA } = require('./automata');

// Run-mode semantics: a transaction is REJECTED when its token completes a
// rule match, i.e. the rule language L is matched by some suffix of the token
// stream ending at this transaction. This is the language Sigma* . L, built by
// adding an any-token self-loop on the NFA start state.

function compileSearchDFA(asts) {
  const nfa = unionNFA(asts);
  for (const tok of ALPHABET) {
    const m = nfa.sym[nfa.start];
    if (!m.has(tok)) m.set(tok, []);
    m.get(tok).push(nfa.start);
  }
  const dfa = determinize(nfa);
  const complete = toCompleteTable(dfa);
  return minimizeDFA(complete);
}

function evaluateTokens(searchDfa, tokens) {
  const hits = new Array(tokens.length);
  let state = searchDfa.start;
  for (let i = 0; i < tokens.length; i++) {
    const idx = TOKEN_INDEX.get(tokens[i]);
    state = searchDfa.trans[state][idx];
    hits[i] = searchDfa.accept.has(state);
  }
  return hits;
}

module.exports = { compileSearchDFA, evaluateTokens };
