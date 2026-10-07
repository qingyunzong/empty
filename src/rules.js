'use strict';

const { parseRuleFile } = require('./regex');
const { compileAst, hitAst, certificate } = require('./automata');

// Compile a rule set (name -> AST) into:
//  - combined: canonical minimal DFA of .*(R1|R2|...) used for hit decisions
//  - perRule:  name -> canonical minimal DFA of .*Ri (for reason reporting)
//  - certificate: { states, hash } of the combined DFA
function compileRuleSet(rules, order) {
  const alts = order.map((name) => hitAst(rules[name]));
  const combinedAst = alts.length === 1 ? alts[0] : { type: 'alt', options: alts };
  const combined = compileAst(combinedAst);
  const perRule = {};
  for (const name of order) perRule[name] = compileAst(hitAst(rules[name]));
  return { combined, perRule, certificate: certificate(combined), order };
}

function loadRuleSet(text) {
  const { rules, order } = parseRuleFile(text);
  return compileRuleSet(rules, order);
}

module.exports = { loadRuleSet, compileRuleSet };
