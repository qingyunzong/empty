'use strict';

const { loadPolicy, loadEvents, parseJsonl } = require('./policy');
const { decide, compareTs } = require('./decide');
const { ancestorsWithDistance, reaches } = require('./graph');
const { canonical, sha256, AuditChain, GENESIS } = require('./audit');
const { PolicyError } = require('./errors');

// Runs a full batch: returns { decisions, audit } where each decision
// carries its chain hash and audit is the summary object for audit.json.
function runBatch(policyText, eventsText) {
  const policy = loadPolicy(policyText);
  const events = loadEvents(eventsText);
  const chain = new AuditChain();
  const decisions = [];
  let allows = 0;
  let denies = 0;

  for (const event of events) {
    const decision = decide(policy, event);
    const hash = chain.append(decision);
    if (decision.decision === 'allow') allows += 1;
    else denies += 1;
    decisions.push({ ...decision, hash });
  }

  const audit = {
    version: 1,
    algorithm: 'sha256-chain',
    genesis: GENESIS,
    decisions: decisions.length,
    allows,
    denies,
    root: chain.head,
    policyHash: sha256(policyText),
    eventsHash: sha256(eventsText),
  };

  return { decisions, audit };
}

module.exports = {
  loadPolicy,
  loadEvents,
  parseJsonl,
  decide,
  compareTs,
  ancestorsWithDistance,
  reaches,
  canonical,
  sha256,
  AuditChain,
  GENESIS,
  PolicyError,
  runBatch,
};
