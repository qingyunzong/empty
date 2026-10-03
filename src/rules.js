'use strict';

const RULE_VERSIONS = {
  v1: {
    version: 'v1',
    amountToleranceCents: 0,
    timeWindowMs: 24 * 3600 * 1000,
    allowOneToMany: false,
    maxGroupSize: 1,
  },
  v2: {
    version: 'v2',
    amountToleranceCents: 500,
    timeWindowMs: 72 * 3600 * 1000,
    allowOneToMany: true,
    maxGroupSize: 3,
  },
};

function getRule(version) {
  const rule = RULE_VERSIONS[version];
  if (!rule) throw new Error(`unknown rule version: ${version}`);
  return rule;
}

module.exports = { RULE_VERSIONS, getRule };
