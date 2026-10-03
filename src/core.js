'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_SEVERITY = 3;

const EXIT = {
  OK: 0,
  HASH_MISMATCH: 10,
  MISSING_TEST: 11,
  POLICY_VERSION_GAP: 12,
};

class CertError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function canonical(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function hashObject(obj) {
  return sha256(canonical(obj));
}

// ---------- loading ----------

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonlFile(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

function loadLots(dir) {
  const data = readJsonFile(path.join(dir, 'lots.json'));
  if (!data || !Array.isArray(data.lots) || typeof data.families !== 'object') {
    throw new CertError('lots.json must contain {families, lots}', EXIT.MISSING_TEST);
  }
  return data;
}

function loadPolicy(dir) {
  const policy = readJsonFile(path.join(dir, 'policy.json'));
  validatePolicyVersions(policy);
  return policy;
}

function validatePolicyVersions(policy) {
  const versions = new Set();
  if (Array.isArray(policy.versions)) {
    for (const v of policy.versions) versions.add(v);
  }
  for (const rule of policy.rules || []) {
    if (typeof rule.version === 'number') versions.add(rule.version);
  }
  if (versions.size === 0) {
    throw new CertError('policy declares no versions', EXIT.POLICY_VERSION_GAP);
  }
  const max = Math.max(...versions);
  for (let v = 1; v <= max; v += 1) {
    if (!versions.has(v)) {
      throw new CertError(`policy version gap: missing version ${v}`, EXIT.POLICY_VERSION_GAP);
    }
  }
}

function loadTestEvents(dir) {
  return readJsonlFile(path.join(dir, 'tests.jsonl'));
}

// ---------- test events ----------

function activeTests(events, lotId) {
  const revoked = new Set(events.filter((e) => e.type === 'revoke').map((e) => e.testId));
  return events
    .filter((e) => e.type === 'test' && !revoked.has(e.testId))
    .filter((e) => lotId === undefined || e.lotId === lotId)
    .map((e) => ({ testId: e.testId, lotId: e.lotId, defects: e.defects || [], ts: e.ts || null }))
    .sort((a, b) => a.testId.localeCompare(b.testId));
}

function knownTestIds(events) {
  return new Set(events.filter((e) => e.type === 'test').map((e) => e.testId));
}

// ---------- decision engine ----------

function decide(lot, families, tests, rules) {
  const family = families[lot.productFamily];
  const familyRisk = family ? family.risk : 0;
  const defects = tests.flatMap((t) => t.defects);
  const maxDefectSeverity = defects.reduce((m, d) => Math.max(m, d.severity), 0);
  const effectiveSeverity = Math.max(familyRisk, maxDefectSeverity);

  const ruleChain = [];
  ruleChain.push({
    step: 'inherit',
    source: 'productFamily',
    family: lot.productFamily,
    inheritedRisk: familyRisk,
  });
  if (defects.length > 0) {
    ruleChain.push({
      step: 'severity-override',
      defectCount: defects.length,
      maxDefectSeverity,
      effectiveSeverity,
    });
  } else {
    ruleChain.push({ step: 'no-defects', effectiveSeverity });
  }

  const matching = rules.filter((r) => r.severity === effectiveSeverity);
  const recalls = matching.filter((r) => r.action === 'recall');

  let conclusion;
  let decisiveRule = null;
  if (recalls.length > 0) {
    recalls.sort(compareRules);
    decisiveRule = recalls[recalls.length - 1];
    conclusion = 'recall';
    ruleChain.push({
      step: 'recall-priority',
      candidates: matching.map((r) => r.id),
      winner: decisiveRule.id,
    });
  } else if (matching.length > 0) {
    const sorted = [...matching].sort(compareRules);
    decisiveRule = sorted[sorted.length - 1];
    conclusion = decisiveRule.action;
    ruleChain.push({
      step: 'latest-effective-wins',
      candidates: matching.map((r) => ({ id: r.id, action: r.action, effectiveFrom: r.effectiveFrom })),
      winner: decisiveRule.id,
    });
  } else {
    conclusion = 'hold';
    ruleChain.push({ step: 'default-hold', reason: 'no rule matches effective severity' });
  }

  return { lotId: lot.lotId, conclusion, effectiveSeverity, decisiveRule: decisiveRule ? decisiveRule.id : null, ruleChain };
}

function compareRules(a, b) {
  const byTime = String(a.effectiveFrom).localeCompare(String(b.effectiveFrom));
  if (byTime !== 0) return byTime;
  return String(a.id).localeCompare(String(b.id));
}

// ---------- counterexample ----------

function findCounterexample(lot, families, tests, rules, decision) {
  if (decision.conclusion !== 'release') return null;

  const perturbations = [];
  for (let s = 1; s <= MAX_SEVERITY; s += 1) {
    perturbations.push({ kind: 'add-defect', defect: { code: 'PERTURB', severity: s } });
  }
  tests.forEach((t, ti) => {
    (t.defects || []).forEach((d, di) => {
      if (d.severity < MAX_SEVERITY) {
        perturbations.push({ kind: 'escalate-defect', testIndex: ti, defectIndex: di, to: d.severity + 1 });
      }
    });
  });

  for (const p of perturbations) {
    const mutated = tests.map((t) => ({ ...t, defects: t.defects.map((d) => ({ ...d })) }));
    if (p.kind === 'add-defect') {
      if (mutated.length === 0) break;
      mutated[0].defects.push({ ...p.defect });
    } else {
      mutated[p.testIndex].defects[p.defectIndex].severity = p.to;
    }
    const flipped = decide(lot, families, mutated, rules);
    if (flipped.conclusion !== 'release') {
      return {
        perturbation: p,
        resultingConclusion: flipped.conclusion,
        resultingRule: flipped.decisiveRule,
      };
    }
  }
  return null;
}

// ---------- certificates ----------

function inputFingerprint(lot, families, tests, policy) {
  return hashObject({
    lot,
    family: families[lot.productFamily] || null,
    tests,
    rules: policy.rules,
  });
}

const CERT_SIGNED_FIELDS = ['certId', 'lotId', 'conclusion', 'effectiveSeverity', 'decisiveRule', 'ruleChain', 'inputHash', 'counterexample'];

function certSignature(cert) {
  const signed = {};
  for (const f of CERT_SIGNED_FIELDS) signed[f] = cert[f] === undefined ? null : cert[f];
  return hashObject(signed);
}

function buildCertificate(lot, families, tests, policy, seq) {
  const decision = decide(lot, families, tests, policy.rules);
  const counterexample = findCounterexample(lot, families, tests, policy.rules, decision);
  const cert = {
    certId: `cert-${String(seq).padStart(6, '0')}`,
    lotId: lot.lotId,
    conclusion: decision.conclusion,
    effectiveSeverity: decision.effectiveSeverity,
    decisiveRule: decision.decisiveRule,
    ruleChain: decision.ruleChain,
    inputHash: inputFingerprint(lot, families, tests, policy),
    counterexample,
    status: 'valid',
  };
  cert.certHash = certSignature(cert);
  return cert;
}

// ---------- store operations ----------

function loadCerts(dir) {
  return readJsonlFile(path.join(dir, 'cert.jsonl'));
}

function writeCerts(dir, certs) {
  const lines = certs.map((c) => JSON.stringify(c)).join('\n');
  fs.writeFileSync(path.join(dir, 'cert.jsonl'), lines === '' ? '' : lines + '\n');
}

function appendCert(dir, cert) {
  fs.appendFileSync(path.join(dir, 'cert.jsonl'), JSON.stringify(cert) + '\n');
}

function certify(dir, lotId) {
  const { lots, families } = loadLots(dir);
  const policy = loadPolicy(dir);
  const events = loadTestEvents(dir);
  const certs = loadCerts(dir);

  const targets = lotId ? lots.filter((l) => l.lotId === lotId) : lots;
  if (lotId && targets.length === 0) {
    throw new CertError(`unknown lot: ${lotId}`, EXIT.MISSING_TEST);
  }

  const issued = [];
  const skipped = [];
  for (const lot of targets) {
    const tests = activeTests(events, lot.lotId);
    if (tests.length === 0) {
      throw new CertError(`missing test records for lot ${lot.lotId}`, EXIT.MISSING_TEST);
    }
    const hash = inputFingerprint(lot, families, tests, policy);
    const latest = [...certs, ...issued].filter((c) => c.lotId === lot.lotId && c.status === 'valid').pop();
    if (latest && latest.inputHash === hash) {
      skipped.push(lot.lotId);
      continue;
    }
    const seq = certs.length + issued.length + 1;
    const cert = buildCertificate(lot, families, tests, policy, seq);
    issued.push(cert);
  }
  for (const cert of issued) appendCert(dir, cert);
  return { issued, skipped };
}

function revoke(dir, testId) {
  const events = loadTestEvents(dir);
  const ids = knownTestIds(events);
  if (!ids.has(testId)) {
    throw new CertError(`cannot revoke unknown test: ${testId}`, EXIT.MISSING_TEST);
  }
  const already = events.some((e) => e.type === 'revoke' && e.testId === testId);
  if (already) {
    return { revoked: testId, staleLots: [], already: true };
  }
  const test = events.find((e) => e.type === 'test' && e.testId === testId);
  fs.appendFileSync(
    path.join(dir, 'tests.jsonl'),
    JSON.stringify({ type: 'revoke', testId, ts: new Date().toISOString() }) + '\n'
  );
  const certs = loadCerts(dir);
  let touched = false;
  for (const cert of certs) {
    if (cert.lotId === test.lotId && cert.status === 'valid') {
      cert.status = 'stale';
      touched = true;
    }
  }
  if (touched) writeCerts(dir, certs);
  return { revoked: testId, staleLots: touched ? [test.lotId] : [], already: false };
}

function verify(dir) {
  const { lots, families } = loadLots(dir);
  const policy = loadPolicy(dir);
  const events = loadTestEvents(dir);
  const certs = loadCerts(dir);
  const problems = [];

  const lotById = new Map(lots.map((l) => [l.lotId, l]));

  for (const cert of certs) {
    if (certSignature(cert) !== cert.certHash) {
      problems.push(`cert ${cert.certId}: signature mismatch (forged or tampered)`);
      continue;
    }
    const lot = lotById.get(cert.lotId);
    if (!lot) {
      problems.push(`cert ${cert.certId}: unknown lot ${cert.lotId}`);
      continue;
    }
    const tests = activeTests(events, cert.lotId);
    if (cert.status === 'valid') {
      if (tests.length === 0) {
        throw new CertError(`missing test records for lot ${cert.lotId}`, EXIT.MISSING_TEST);
      }
      const hash = inputFingerprint(lot, families, tests, policy);
      if (hash !== cert.inputHash) {
        problems.push(`cert ${cert.certId}: input hash mismatch`);
        continue;
      }
      const decision = decide(lot, families, tests, policy.rules);
      if (decision.conclusion !== cert.conclusion) {
        problems.push(`cert ${cert.certId}: conclusion mismatch (expected ${decision.conclusion})`);
      }
    }
  }

  if (problems.length > 0) {
    throw new CertError('verification failed:\n' + problems.join('\n'), EXIT.HASH_MISMATCH);
  }
  return { checked: certs.length };
}

module.exports = {
  EXIT,
  CertError,
  MAX_SEVERITY,
  canonical,
  sha256,
  hashObject,
  loadLots,
  loadPolicy,
  loadTestEvents,
  activeTests,
  decide,
  findCounterexample,
  inputFingerprint,
  certSignature,
  buildCertificate,
  loadCerts,
  certify,
  revoke,
  verify,
};
