'use strict';
const { mergedOrder, replay, applyWrites, stateEqual } = require('./history');

// Reference checker: enumerate every serial permutation (small histories only).
// Serializable iff some permutation reproduces every recorded read and the
// merged final state.
function bruteCheck(txns) {
  const orderIds = mergedOrder(txns).map((t) => t.id);
  const byId = new Map(txns.map((t) => [t.id, t]));
  const target = applyWrites(byId, orderIds);
  const ids = txns.map((t) => t.id);
  let witness = null;

  const permute = (prefix, rest) => {
    if (witness) return;
    if (rest.length === 0) {
      const rep = replay(byId, prefix);
      if (rep.ok && stateEqual(rep.state, target)) witness = prefix.slice();
      return;
    }
    for (let i = 0; i < rest.length; i++) {
      prefix.push(rest[i]);
      permute(prefix, rest.slice(0, i).concat(rest.slice(i + 1)));
      prefix.pop();
      if (witness) return;
    }
  };
  permute([], ids);
  return { serializable: witness !== null, witness };
}

module.exports = { bruteCheck };
