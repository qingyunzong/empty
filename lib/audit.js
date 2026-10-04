'use strict';

const { AuditError } = require('./errors');
const { loadRules } = require('./rules');
const { parseLedger } = require('./ledger');
const {
  buildNfa,
  combineNfas,
  computeAlphabet,
  nfaToDfa,
  simulate,
  minimizeDfa,
  verifyCertificate,
  equivDfas,
} = require('./automata');

function roundAmount(x) {
  return Math.round(x * 1e6) / 1e6;
}

function buildSetDfa(rules, extraNfas) {
  const nfas = rules.map((r) => buildNfa(r.ast));
  const alphabet = computeAlphabet([...nfas, ...(extraNfas || [])]);
  const dfa = nfaToDfa(combineNfas(nfas), alphabet);
  return { nfas, alphabet, dfa };
}

// Audit a ledger (JSONL text) against a rule set.
// A line matching several rules with conflicting actions is an unknown
// conflict: it is reported as AMBIGUOUS_RULE, never silently treated as a
// non-match.
function runAudit(rulesObj, ledgerText) {
  const rules = loadRules(rulesObj);
  const entries = parseLedger(ledgerText);

  const nfas = rules.map((r) => buildNfa(r.ast));
  const alphabet = computeAlphabet(nfas);
  const dfas = nfas.map((nfa) => nfaToDfa(nfa, alphabet));

  const lineNumbers = [];
  let total = 0;
  for (const entry of entries) {
    const hits = [];
    for (let i = 0; i < rules.length; i++) {
      if (simulate(dfas[i], entry.concat)) hits.push(rules[i]);
    }
    const actions = new Set(hits.map((h) => h.action));
    if (actions.size > 1) {
      throw new AuditError(
        'AMBIGUOUS_RULE',
        `line ${entry.lineNo} matches rules [${hits.map((h) => h.id).join(', ')}] ` +
          `with conflicting actions [${[...actions].join(', ')}]`
      );
    }
    if (hits.length > 0) {
      lineNumbers.push(entry.lineNo);
      total += entry.fields.direction === 'credit' ? entry.fields.amount : -entry.fields.amount;
    }
  }

  const unionDfa = nfaToDfa(combineNfas(nfas), alphabet);
  const { minDfa, certificate } = minimizeDfa(unionDfa);
  const check = verifyCertificate(unionDfa, certificate);

  return {
    lines: entries.length,
    match: {
      count: lineNumbers.length,
      totalAmount: roundAmount(total),
      lineNumbers,
    },
    minimized: {
      states: minDfa.states.length,
      transitions: minDfa.states.reduce((acc, s) => acc + s.trans.length, 0),
      certificateValid: check.valid,
      certificate,
    },
  };
}

// Equivalence of two rule sets (union of each set's pattern languages).
// When inequivalent, the witness is the shortest string in the symmetric
// difference, ties broken by numerically smallest code points.
function compareRuleSets(objA, objB) {
  const rulesA = loadRules(objA);
  const rulesB = loadRules(objB);
  const nfasA = rulesA.map((r) => buildNfa(r.ast));
  const nfasB = rulesB.map((r) => buildNfa(r.ast));
  const alphabet = computeAlphabet([...nfasA, ...nfasB]);
  const dfaA = nfaToDfa(combineNfas(nfasA), alphabet);
  const dfaB = nfaToDfa(combineNfas(nfasB), alphabet);
  return equivDfas(dfaA, dfaB);
}

function minimizeRules(rulesObj) {
  const rules = loadRules(rulesObj);
  const { alphabet, dfa } = buildSetDfa(rules);
  void alphabet;
  const { minDfa, certificate } = minimizeDfa(dfa);
  const check = verifyCertificate(dfa, certificate);
  return {
    states: minDfa.states.length,
    transitions: minDfa.states.reduce((acc, s) => acc + s.trans.length, 0),
    certificateValid: check.valid,
    certificate,
  };
}

module.exports = { runAudit, compareRuleSets, minimizeRules };
