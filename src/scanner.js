'use strict';

const { AhoCorasick } = require('./aho');
const { compileRegex, scanDFA, trajectoryDFA } = require('./regex-dfa');

class ScanError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const MAX_RULES = 5000;

// rules: [{id, type: 'exact'|'regex', pattern}]
function validateRules(rules) {
  if (!Array.isArray(rules)) throw new ScanError('BAD_RULE', 'rules must be an array');
  if (rules.length > MAX_RULES) {
    throw new ScanError('OFFSET_OVERFLOW', `rule count ${rules.length} exceeds ${MAX_RULES}`);
  }
  const ids = new Set();
  const exactPatterns = new Set();
  for (const r of rules) {
    if (!r || typeof r.id !== 'string' || (r.type !== 'exact' && r.type !== 'regex') ||
        typeof r.pattern !== 'string' || r.pattern.length === 0) {
      throw new ScanError('BAD_RULE', 'each rule needs id, type(exact|regex), non-empty pattern');
    }
    if (ids.has(r.id)) throw new ScanError('DUP_RULE', `duplicate rule id: ${r.id}`);
    ids.add(r.id);
    if (r.type === 'exact') {
      if (exactPatterns.has(r.pattern)) {
        throw new ScanError('DUP_RULE', `duplicate exact pattern: ${r.pattern}`);
      }
      exactPatterns.add(r.pattern);
    }
  }
  return rules;
}

function buildAutomata(rules) {
  validateRules(rules);
  const ac = new AhoCorasick();
  const dfas = new Map();
  const byId = new Map();
  for (const r of rules) {
    byId.set(r.id, r);
    if (r.type === 'exact') ac.add(r.pattern, r.id);
    else dfas.set(r.id, compileRegex(r.pattern));
  }
  ac.build();
  return { ac, dfas, byId };
}

// Unified hit ordering: start asc, then length asc, then ruleId asc.
function cmpHits(a, b) {
  return a.start - b.start ||
    (a.end - a.start) - (b.end - b.start) ||
    (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0);
}

function scanLine(text, automata) {
  const hits = [];
  for (const h of automata.ac.scan(text)) hits.push({ ...h, kind: 'exact' });
  for (const [ruleId, dfa] of automata.dfas) {
    for (const h of scanDFA(dfa, text)) hits.push({ ...h, ruleId, kind: 'regex' });
  }
  hits.sort(cmpHits);
  return hits;
}

// Automaton state trajectory for one hit (for the audit certificate).
function hitTrajectory(hit, lineText, automata) {
  if (hit.kind === 'exact') {
    const pattern = automata.byId.get(hit.ruleId).pattern;
    return automata.ac.trajectory(pattern);
  }
  return trajectoryDFA(automata.dfas.get(hit.ruleId), lineText, hit.start, hit.end);
}

module.exports = { ScanError, validateRules, buildAutomata, scanLine, cmpHits, hitTrajectory, MAX_RULES };
