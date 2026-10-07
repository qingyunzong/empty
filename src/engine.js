'use strict';

const { tokenizeTx, TOKEN_INDEX } = require('./tokenize');
const { runDfa } = require('./automata');

// Evaluate a transaction log against a compiled rule set.
// A transaction is REJECTED when the combined hit-DFA accepts after
// consuming its token (some substring ending here matches a rule).
// Returns decisions plus the token string for each transaction.
function evaluate(ruleSet, txs) {
  const tokens = txs.map((tx) => tokenizeTx(tx));
  const indices = tokens.map((t) => TOKEN_INDEX.get(t));
  const hits = runDfa(ruleSet.combined, indices);
  const perRuleHits = {};
  for (const name of ruleSet.order) perRuleHits[name] = runDfa(ruleSet.perRule[name], indices);
  return txs.map((tx, i) => {
    const reasons = ruleSet.order.filter((name) => perRuleHits[name][i]);
    return {
      id: tx.id,
      account: tx.account,
      amount: tx.amount,
      token: tokens[i],
      decision: hits[i] ? 'REJECT' : 'APPROVE',
      rules: reasons,
    };
  });
}

module.exports = { evaluate };
