'use strict';

const { parseRegex } = require('./regex');
const { nfaFromAst, dfaFromNfa, minimizeDfa, hasLiveAccept } = require('./automata');
const { FlowError } = require('./errors');

const MAX_LOG = 200;
const MAX_K = 6;
const BALANCE_CAP = MAX_LOG + MAX_K;

function compileFlow(source) {
  const { ast, eventsUsed } = parseRegex(source);
  const alphabet = [...eventsUsed].sort();
  if (alphabet.length === 0) {
    throw new FlowError('EMPTY_ALPHABET', 'flow regex mentions no settlement events');
  }
  const dfa = minimizeDfa(dfaFromNfa(nfaFromAst(ast), alphabet), alphabet);
  return { dfa, alphabet };
}

// Intersect the flow DFA with the global audit rule "冲正不能撤销未入账":
// a monitor tracks the number of unmatched 入账 (post) events; 冲正 (reverse)
// is only legal while the balance is positive.
function withReversalMonitor(dfa, alphabet) {
  const keyOf = (f, b) => `${f}:${b}`;
  const ids = new Map([[keyOf(dfa.start, 0), 0]]);
  const pairs = [[dfa.start, 0]];
  const trans = [new Map()];
  const accept = new Set();
  if (dfa.accept.has(dfa.start)) accept.add(0);
  for (let qi = 0; qi < pairs.length; qi += 1) {
    const [f, b] = pairs[qi];
    for (const a of alphabet) {
      const tf = dfa.trans[f].get(a);
      if (tf === undefined) continue;
      let nb;
      if (a === 'post') nb = Math.min(b + 1, BALANCE_CAP);
      else if (a === 'reverse') {
        if (b === 0) continue;
        nb = b - 1;
      } else nb = b;
      const k = keyOf(tf, nb);
      if (!ids.has(k)) {
        ids.set(k, pairs.length);
        pairs.push([tf, nb]);
        trans.push(new Map());
        if (dfa.accept.has(tf)) accept.add(ids.get(k));
      }
      trans[qi].set(a, ids.get(k));
    }
  }
  return { states: pairs.length, start: 0, accept, trans };
}

function prepareFlow(source) {
  const { dfa, alphabet } = compileFlow(source);
  const monitored = withReversalMonitor(dfa, alphabet);
  if (!hasLiveAccept(monitored)) {
    throw new FlowError(
      'NONTERM_AUTOMATON',
      'automaton has no reachable accepting state (empty language under audit rules)',
    );
  }
  return { dfa: monitored, alphabet };
}

module.exports = { compileFlow, prepareFlow, withReversalMonitor, MAX_LOG, MAX_K };
