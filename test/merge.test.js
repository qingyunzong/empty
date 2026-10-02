'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../index');

const {
  mergeRules,
  decisionFor,
  decisionsFor,
  featuresOf,
  validateDomain,
  ValidationError,
} = require('../merge');

const DOMAIN = { materials: ['steel', 'copper'], grades: ['A', 'B'] };

function rule(overrides) {
  return {
    id: 'r1',
    material: 'steel',
    grade: 'A',
    priority: 1,
    enabled: true,
    fraction: 0.5,
    action: 'sample',
    ...overrides,
  };
}

function decisionMap(decisions) {
  const map = new Map();
  for (const d of decisions) map.set(`${d.material}::${d.grade}`, d);
  return map;
}

test('acceptance 1: rules on different materials and different fields of same rule merge cleanly', () => {
  const base = [rule({ id: 'r1', fraction: 0.2, action: 'sample' })];
  // local edits fraction of r1 and adds a copper rule; remote edits action of r1
  const local = [
    rule({ id: 'r1', fraction: 0.8, action: 'sample' }),
    rule({ id: 'r2', material: 'copper', grade: 'B', priority: 3, action: 'reject' }),
  ];
  const remote = [rule({ id: 'r1', fraction: 0.2, action: 'inspect' })];

  const result = mergeRules({ domain: DOMAIN, base, local, remote });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.rules.length, 2);

  const r1 = result.rules.find((r) => r.id === 'r1');
  assert.equal(r1.fraction, 0.8); // from local
  assert.equal(r1.action, 'inspect'); // from remote

  const decisions = decisionMap(result.decisions);
  assert.equal(decisions.get('copper::B').action, 'reject');
  assert.equal(decisions.get('steel::A').action, 'inspect');
  assert.equal(decisions.get('steel::B').action, null);
});

test('acceptance 2: same rule changed to different actions on both sides conflicts', () => {
  const base = [rule({ id: 'r1', action: 'sample' })];
  const local = [rule({ id: 'r1', action: 'inspect' })];
  const remote = [rule({ id: 'r1', action: 'reject' })];

  const result = mergeRules({ domain: DOMAIN, base, local, remote });
  assert.equal(result.status, 'conflict');
  const conflict = result.conflicts.find((c) => c.type === 'field');
  assert.ok(conflict, 'expected a field conflict');
  assert.equal(conflict.ruleId, 'r1');
  assert.deepEqual(
    conflict.fields.map((f) => f.field),
    ['action'],
  );
  // conflicted rule is not emitted into the merged rule set
  assert.equal(result.rules.find((r) => r.id === 'r1'), undefined);
});

test('acceptance 3: added rules winning the same feature with different actions is a semantic conflict', () => {
  const base = [rule({ id: 'r1', priority: 1, action: 'sample' })];
  // local adds a higher-priority rule that wins steel::A with action 'inspect'
  const local = [
    rule({ id: 'r1', priority: 1, action: 'sample' }),
    rule({ id: 'r2', priority: 9, action: 'inspect' }),
  ];
  // remote adds a different higher-priority rule that wins steel::A with action 'reject'
  const remote = [
    rule({ id: 'r1', priority: 1, action: 'sample' }),
    rule({ id: 'r3', priority: 8, action: 'reject' }),
  ];

  const result = mergeRules({ domain: DOMAIN, base, local, remote });
  assert.equal(result.status, 'conflict');
  const semantic = result.conflicts.filter((c) => c.type === 'semantic');
  assert.equal(semantic.length, 1);
  assert.equal(semantic[0].material, 'steel');
  assert.equal(semantic[0].grade, 'A');
  assert.equal(semantic[0].localAction, 'inspect');
  assert.equal(semantic[0].remoteAction, 'reject');
  // structural merge itself is clean: all three rules are present
  assert.deepEqual(
    result.rules.map((r) => r.id).sort(),
    ['r1', 'r2', 'r3'],
  );
});

test('one-sided decision change on a feature is not a semantic conflict', () => {
  const base = [rule({ id: 'r1', priority: 1, action: 'sample' })];
  const local = [
    rule({ id: 'r1', priority: 1, action: 'sample' }),
    rule({ id: 'r2', priority: 5, action: 'reject' }),
  ];
  const remote = [rule({ id: 'r1', priority: 1, action: 'sample', fraction: 0.9 })];

  const result = mergeRules({ domain: DOMAIN, base, local, remote });
  assert.equal(result.status, 'ok');
  const decisions = decisionMap(result.decisions);
  assert.equal(decisions.get('steel::A').action, 'reject');
  assert.equal(decisions.get('steel::A').ruleId, 'r2');
});

test('both sides changing a feature to the same action is not a conflict', () => {
  const base = [rule({ id: 'r1', priority: 1, action: 'sample' })];
  const local = [rule({ id: 'r1', priority: 1, action: 'inspect' })];
  const remote = [rule({ id: 'r1', priority: 1, action: 'inspect' })];

  const result = mergeRules({ domain: DOMAIN, base, local, remote });
  assert.equal(result.status, 'ok');
  assert.equal(result.rules[0].action, 'inspect');
});

test('structural merge: delete vs modify and add vs add conflicts', () => {
  const base = [rule({ id: 'r1' }), rule({ id: 'r2', fraction: 0.1 })];
  const local = [rule({ id: 'r2', fraction: 0.7 }), rule({ id: 'r3', action: 'a1' })];
  const remote = [rule({ id: 'r1' }), rule({ id: 'r3', action: 'a2' })];

  const result = mergeRules({ domain: DOMAIN, base, local, remote });
  assert.equal(result.status, 'conflict');
  const types = result.conflicts.map((c) => c.type).sort();
  assert.deepEqual(types, ['add-vs-add', 'delete-vs-modify']);
});

test('structural merge: clean delete on one side with untouched other side deletes the rule', () => {
  const base = [rule({ id: 'r1' }), rule({ id: 'r2' })];
  const local = [rule({ id: 'r1' })];
  const remote = [rule({ id: 'r1' }), rule({ id: 'r2' })];

  const result = mergeRules({ domain: DOMAIN, base, local, remote });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.rules.map((r) => r.id), ['r1']);
});

test('priority tie is broken by lexicographic rule id', () => {
  const rules = [
    rule({ id: 'rb', priority: 5, action: 'b-action' }),
    rule({ id: 'ra', priority: 5, action: 'a-action' }),
    rule({ id: 'rc', priority: 4, action: 'c-action' }),
  ];
  const decision = decisionFor(rules, { material: 'steel', grade: 'A' });
  assert.equal(decision.ruleId, 'ra');
  assert.equal(decision.action, 'a-action');
});

test('disabled rules never win', () => {
  const rules = [
    rule({ id: 'r1', priority: 100, enabled: false, action: 'off' }),
    rule({ id: 'r2', priority: 1, action: 'on' }),
  ];
  const decision = decisionFor(rules, { material: 'steel', grade: 'A' });
  assert.equal(decision.ruleId, 'r2');
});

test('validation: fraction outside [0,1] is rejected', () => {
  assert.throws(
    () => mergeRules({ domain: DOMAIN, base: [rule({ fraction: 1.5 })], local: [], remote: [] }),
    (err) => err instanceof ValidationError && /fraction/.test(err.message),
  );
  assert.throws(
    () => mergeRules({ domain: DOMAIN, base: [], local: [rule({ fraction: -0.1 })], remote: [] }),
    ValidationError,
  );
  // boundaries are legal
  const ok = mergeRules({
    domain: DOMAIN,
    base: [],
    local: [rule({ id: 'lo', fraction: 0 }), rule({ id: 'hi', fraction: 1 })],
    remote: [],
  });
  assert.equal(ok.status, 'ok');
});

test('validation: material or grade outside the domain is rejected', () => {
  assert.throws(
    () => mergeRules({ domain: DOMAIN, base: [], local: [rule({ material: 'wood' })], remote: [] }),
    (err) => err instanceof ValidationError && /material/.test(err.message),
  );
  assert.throws(
    () => mergeRules({ domain: DOMAIN, base: [], local: [], remote: [rule({ grade: 'Z' })] }),
    (err) => err instanceof ValidationError && /grade/.test(err.message),
  );
});

test('validation: malformed domain and duplicate ids are rejected', () => {
  assert.throws(() => validateDomain({ materials: [], grades: ['A'] }), ValidationError);
  assert.throws(() => validateDomain({ materials: ['a', 'a'], grades: ['A'] }), ValidationError);
  assert.throws(
    () => mergeRules({ domain: DOMAIN, base: [rule({}), rule({})], local: [], remote: [] }),
    (err) => err instanceof ValidationError && /duplicate/.test(err.message),
  );
});

// Deterministic PRNG so the property test is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent reference: scan for the max priority among enabled matching
// rules, then pick the lexicographically smallest id among those.
function referenceDecision(rules, feature) {
  let maxPriority = -Infinity;
  for (const r of rules) {
    if (r.enabled && r.material === feature.material && r.grade === feature.grade) {
      if (r.priority > maxPriority) maxPriority = r.priority;
    }
  }
  if (maxPriority === -Infinity) {
    return { ruleId: null, action: null, fraction: null };
  }
  let winner = null;
  for (const r of rules) {
    if (
      r.enabled &&
      r.material === feature.material &&
      r.grade === feature.grade &&
      r.priority === maxPriority &&
      (winner === null || r.id < winner.id)
    ) {
      winner = r;
    }
  }
  return { ruleId: winner.id, action: winner.action, fraction: winner.fraction };
}

test('property: for <=8 features, every enabled subset matches the reference decision', () => {
  const rand = mulberry32(20261003);
  const domain = validateDomain({ materials: ['m1', 'm2', 'm3', 'm4'], grades: ['g1', 'g2'] });
  const features = featuresOf(domain);
  assert.ok(features.length <= 8);

  const actions = ['sample', 'inspect', 'reject', 'skip'];
  const template = [];
  for (let i = 0; i < 9; i += 1) {
    const feature = features[Math.floor(rand() * features.length)];
    template.push({
      id: `rule-${i}`,
      material: feature.material,
      grade: feature.grade,
      priority: Math.floor(rand() * 4),
      enabled: true,
      fraction: Math.round(rand() * 100) / 100,
      action: actions[Math.floor(rand() * actions.length)],
    });
  }

  const subsets = 1 << template.length;
  for (let mask = 0; mask < subsets; mask += 1) {
    const rules = template.map((r, i) => ({ ...r, enabled: (mask & (1 << i)) !== 0 }));
    const actual = decisionsFor(rules, features);
    for (let f = 0; f < features.length; f += 1) {
      const expected = referenceDecision(rules, features[f]);
      assert.deepEqual(
        {
          ruleId: actual[f].ruleId,
          action: actual[f].action,
          fraction: actual[f].fraction,
        },
        expected,
        `mask=${mask} feature=${features[f].material}::${features[f].grade}`,
      );
    }
  }
});

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function runCli(dir, files) {
  const out = path.join(dir, 'out.json');
  const captured = { stdout: '', stderr: '' };
  const io = {
    stdout: { write: (chunk) => { captured.stdout += chunk; } },
    stderr: { write: (chunk) => { captured.stderr += chunk; } },
  };
  const status = main(
    [
      'merge-rules',
      '--domain', files.domain,
      '--base', files.base,
      '--local', files.local,
      '--remote', files.remote,
      '--out', out,
    ],
    io,
  );
  return { proc: { status, ...captured }, out };
}

test('CLI: clean merge exits 0 and writes merged rules, conflicts and decisions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-cli-'));
  const files = {
    domain: writeJson(dir, 'domain.json', DOMAIN),
    base: writeJson(dir, 'base.json', [rule({ id: 'r1', fraction: 0.2 })]),
    local: writeJson(dir, 'local.json', [rule({ id: 'r1', fraction: 0.6 })]),
    remote: writeJson(dir, 'remote.json', [rule({ id: 'r1', fraction: 0.2, action: 'inspect' })]),
  };
  const { proc, out } = runCli(dir, files);
  assert.equal(proc.status, 0, proc.stderr);
  const result = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(result.status, 'ok');
  assert.equal(result.rules[0].fraction, 0.6);
  assert.equal(result.rules[0].action, 'inspect');
  assert.equal(result.decisions.length, 4);
});

test('CLI: conflicting merge exits 1 and still writes the report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-cli-'));
  const files = {
    domain: writeJson(dir, 'domain.json', DOMAIN),
    base: writeJson(dir, 'base.json', [rule({ id: 'r1', action: 'sample' })]),
    local: writeJson(dir, 'local.json', [rule({ id: 'r1', action: 'inspect' })]),
    remote: writeJson(dir, 'remote.json', [rule({ id: 'r1', action: 'reject' })]),
  };
  const { proc, out } = runCli(dir, files);
  assert.equal(proc.status, 1, proc.stderr);
  const result = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(result.status, 'conflict');
  assert.ok(result.conflicts.length > 0);
});

test('CLI: invalid rules or domain exits 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-cli-'));
  const files = {
    domain: writeJson(dir, 'domain.json', DOMAIN),
    base: writeJson(dir, 'base.json', [rule({ id: 'r1', fraction: 2 })]),
    local: writeJson(dir, 'local.json', []),
    remote: writeJson(dir, 'remote.json', []),
  };
  const { proc } = runCli(dir, files);
  assert.equal(proc.status, 2);
  assert.match(proc.stderr, /fraction/);

  const badDomain = {
    ...files,
    domain: writeJson(dir, 'bad-domain.json', { materials: ['steel'], grades: 'oops' }),
    base: writeJson(dir, 'ok-base.json', []),
  };
  const second = runCli(dir, badDomain);
  assert.equal(second.proc.status, 2);
});

test('CLI: missing arguments exits 2 with usage', () => {
  let stderr = '';
  const status = main(['merge-rules'], { stdout: { write() {} }, stderr: { write: (c) => { stderr += c; } } });
  assert.equal(status, 2);
  assert.match(stderr, /Usage:/);
});
