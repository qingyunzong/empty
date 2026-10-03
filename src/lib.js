'use strict';

const crypto = require('node:crypto');

const MIN_SEVERITY = 1;
const MAX_SEVERITY = 3;

class QaError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const EXIT_CODES = {
  HASH_MISMATCH: 10,
  MISSING_TEST: 11,
  POLICY_VERSION_GAP: 12,
};

function canonicalize(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function hashObject(value) {
  return sha256hex(canonicalize(value));
}

function validatePolicy(policy) {
  if (!policy || !Array.isArray(policy.versions) || policy.versions.length === 0) {
    throw new QaError('POLICY_VERSION_GAP', 'policy has no versions');
  }
  const seen = policy.versions.map((v) => v.version).sort((a, b) => a - b);
  for (let i = 0; i < seen.length; i += 1) {
    if (seen[i] !== i + 1) {
      throw new QaError(
        'POLICY_VERSION_GAP',
        `policy version gap: expected version ${i + 1}, found ${seen[i]}`,
      );
    }
  }
  if (!policy.families || typeof policy.families !== 'object') {
    throw new QaError('POLICY_VERSION_GAP', 'policy is missing family risk levels');
  }
}

function allRules(policy) {
  const rules = [];
  for (const version of policy.versions) {
    for (const rule of version.rules || []) {
      rules.push({ id: rule.id, severity: rule.severity, action: rule.action, since: version.version });
    }
  }
  return rules;
}

function pickLatest(rules) {
  const maxSince = Math.max(...rules.map((r) => r.since));
  return rules.filter((r) => r.since === maxSince);
}

// Core decision: lot inherits family risk; defect severity overrides it.
// Recall always wins; release/hold conflicts resolve to the later effective version.
function decide(policy, inheritedRisk, defectSeverities) {
  const rules = allRules(policy);
  const maxDefect = defectSeverities.length ? Math.max(...defectSeverities) : 0;
  const effectiveSeverity = Math.max(inheritedRisk, maxDefect);
  const ruleChain = [`inherit:family-risk=${inheritedRisk}`];
  if (maxDefect > inheritedRisk) {
    ruleChain.push(`override:defect-severity=${maxDefect}`);
  }

  const applicable = rules.filter((r) => r.severity === effectiveSeverity);
  const recalls = applicable.filter((r) => r.action === 'recall');
  if (recalls.length > 0) {
    const winners = pickLatest(recalls);
    ruleChain.push(`rule:${winners[0].id}:recall@v${winners[0].since}`);
    return { conclusion: 'recall', effectiveSeverity, ruleChain };
  }

  const gates = applicable.filter((r) => r.action === 'release' || r.action === 'hold');
  if (gates.length === 0) {
    ruleChain.push('default:hold');
    return { conclusion: 'hold', effectiveSeverity, ruleChain };
  }
  const winners = pickLatest(gates);
  const actions = new Set(winners.map((r) => r.action));
  // Same version, conflicting actions: hold wins (fail-safe).
  const action = actions.size > 1 ? 'hold' : winners[0].action;
  const chosen = winners.find((r) => r.action === action);
  ruleChain.push(`rule:${chosen.id}:${action}@v${chosen.since}`);
  return { conclusion: action, effectiveSeverity, ruleChain };
}

// A small perturbation: bump one defect severity by one step, or drop one defect.
function findCounterexample(policy, inheritedRisk, activeTests) {
  const base = decide(policy, inheritedRisk, activeTests.map((t) => t.severity));
  if (base.conclusion !== 'release') return null;

  const perturbations = [];
  for (const test of activeTests) {
    for (const delta of [-1, 1]) {
      const next = test.severity + delta;
      if (next < MIN_SEVERITY || next > MAX_SEVERITY) continue;
      perturbations.push({
        description: { kind: 'severity-shift', testId: test.testId, from: test.severity, to: next },
        severities: activeTests.map((t) => (t.testId === test.testId ? next : t.severity)),
      });
    }
    perturbations.push({
      description: { kind: 'remove-test', testId: test.testId },
      severities: activeTests.filter((t) => t.testId !== test.testId).map((t) => t.severity),
    });
  }

  for (const p of perturbations) {
    const flipped = decide(policy, inheritedRisk, p.severities);
    if (flipped.conclusion !== 'release') {
      return {
        perturbation: p.description,
        conclusion: flipped.conclusion,
        ruleChain: flipped.ruleChain,
      };
    }
  }
  return null;
}

function computeInputHash(lot, familyRisk, activeTests, policy) {
  const sortedTests = activeTests
    .map((t) => ({ testId: t.testId, defect: t.defect, severity: t.severity }))
    .sort((a, b) => (a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0));
  return hashObject({ lot, familyRisk, tests: sortedTests, policy });
}

function buildCertificate({ lotId, conclusion, ruleChain, inputHash, counterexample }) {
  const body = { lotId, conclusion, status: 'valid', ruleChain, inputHash };
  if (counterexample) body.counterexample = counterexample;
  const certId = hashObject(body).slice(0, 16);
  const cert = { certId, ...body };
  return { ...cert, selfHash: hashObject(cert) };
}

function resolveTests(testEvents) {
  const testsByLot = new Map();
  const knownTestIds = new Set();
  for (const event of testEvents) {
    if (event.type === 'test') {
      knownTestIds.add(event.testId);
      if (!testsByLot.has(event.lotId)) testsByLot.set(event.lotId, []);
      testsByLot.get(event.lotId).push({
        testId: event.testId,
        defect: event.defect,
        severity: event.severity,
        revoked: false,
      });
    }
  }
  for (const event of testEvents) {
    if (event.type === 'revoke') {
      if (!knownTestIds.has(event.testId)) {
        throw new QaError('MISSING_TEST', `revoke references unknown test ${event.testId}`);
      }
      for (const tests of testsByLot.values()) {
        for (const t of tests) {
          if (t.testId === event.testId) t.revoked = true;
        }
      }
    }
  }
  return testsByLot;
}

function evaluate({ lots, testEvents, policy, existingCerts }) {
  validatePolicy(policy);
  const testsByLot = resolveTests(testEvents);
  const certs = (existingCerts || []).map((c) => ({ ...c }));
  const appended = [];

  const sortedLots = [...lots].sort((a, b) => (a.lotId < b.lotId ? -1 : 1));
  for (const lot of sortedLots) {
    const familyRisk = policy.families[lot.productFamily];
    if (familyRisk === undefined) {
      throw new QaError('POLICY_VERSION_GAP', `no risk level for family ${lot.productFamily}`);
    }
    const recorded = testsByLot.get(lot.lotId) || [];
    if (recorded.length === 0) {
      throw new QaError('MISSING_TEST', `lot ${lot.lotId} has no inspection records`);
    }
    const active = recorded.filter((t) => !t.revoked);
    const inputHash = computeInputHash(lot, familyRisk, active, policy);

    const latest = [...certs, ...appended].filter((c) => c.lotId === lot.lotId).pop();
    if (latest && latest.status === 'valid' && latest.inputHash === inputHash) {
      continue; // idempotent: nothing changed for this lot
    }

    for (const cert of certs) {
      if (cert.lotId === lot.lotId && cert.status === 'valid') {
        cert.status = 'needs-recompute';
      }
    }

    const decision = decide(policy, familyRisk, active.map((t) => t.severity));
    const counterexample = findCounterexample(policy, familyRisk, active);
    appended.push(buildCertificate({
      lotId: lot.lotId,
      conclusion: decision.conclusion,
      ruleChain: decision.ruleChain,
      inputHash,
      counterexample,
    }));
  }

  return { certs: [...certs, ...appended], appended };
}

function verify({ lots, testEvents, policy, certs }) {
  validatePolicy(policy);
  const testsByLot = resolveTests(testEvents);

  for (const cert of certs) {
    const { selfHash, ...body } = cert;
    if (!selfHash || hashObject(body) !== selfHash) {
      throw new QaError('HASH_MISMATCH', `certificate ${cert.certId || '?'} failed integrity check`);
    }
  }

  for (const lot of lots) {
    const familyRisk = policy.families[lot.productFamily];
    const recorded = testsByLot.get(lot.lotId) || [];
    if (recorded.length === 0) {
      throw new QaError('MISSING_TEST', `lot ${lot.lotId} has no inspection records`);
    }
    const active = recorded.filter((t) => !t.revoked);
    const inputHash = computeInputHash(lot, familyRisk, active, policy);
    const lotCerts = certs.filter((c) => c.lotId === lot.lotId);
    const latest = lotCerts[lotCerts.length - 1];
    if (!latest || latest.status !== 'valid' || latest.inputHash !== inputHash) {
      throw new QaError('HASH_MISMATCH', `lot ${lot.lotId} has no valid certificate matching current inputs`);
    }
  }
  return true;
}

module.exports = {
  QaError,
  EXIT_CODES,
  canonicalize,
  hashObject,
  validatePolicy,
  allRules,
  decide,
  findCounterexample,
  computeInputHash,
  buildCertificate,
  resolveTests,
  evaluate,
  verify,
};
