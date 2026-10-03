'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  validateDomain,
  validateRules,
  featuresOf,
  decide,
  mergeRules,
  mergeAll,
} = require('../lib/merge');

const DOMAIN = { materials: ['steel', 'copper'], grades: ['A', 'B'] };

function rule(overrides) {
  return {
    id: 'r1',
    material: 'steel',
    grade: 'A',
    priority: 1,
    enabled: true,
    fraction: 0.5,
    action: 'accept',
    ...overrides,
  };
}

// Acceptance 1: rules on different materials merge, and field-level changes
// to the same rule from both sides merge cleanly.
test('acceptance 1: disjoint rules and per-field edits merge successfully', () => {
  const base = [
    rule({ id: 'r1', material: 'steel', fraction: 0.2 }),
    rule({ id: 'r2', material: 'copper', priority: 3, action: 'reject' }),
  ];
  const local = [
    rule({ id: 'r1', material: 'steel', fraction: 0.8 }), // local edits fraction
    rule({ id: 'r2', material: 'copper', priority: 3, action: 'reject' }),
    rule({ id: 'r3', material: 'copper', grade: 'B', priority: 5, action: 'review' }),
  ];
  const remote = [
    rule({ id: 'r1', material: 'steel', fraction: 0.2, priority: 9 }), // remote edits priority
    rule({ id: 'r2', material: 'copper', priority: 4, action: 'reject' }), // remote edits priority
    rule({ id: 'r4', material: 'steel', grade: 'B', priority: 2, action: 'accept' }),
  ];

  const result = mergeAll(DOMAIN, base, local, remote);
  assert.deepEqual(result.conflicts, []);

  const merged = Object.fromEntries(result.rules.map((r) => [r.id, r]));
  assert.equal(merged.r1.fraction, 0.8); // from local
  assert.equal(merged.r1.priority, 9); // from remote
  assert.equal(merged.r2.priority, 4); // from remote
  assert.equal(merged.r3.action, 'review'); // added by local
  assert.equal(merged.r4.action, 'accept'); // added by remote

  // Every feature gets a decision from the merged rules.
  assert.deepEqual(Object.keys(result.decisions).sort(), [
    'copper/A',
    'copper/B',
    'steel/A',
    'steel/B',
  ]);
  assert.deepEqual(result.decisions['steel/A'], { ruleId: 'r1', action: 'accept' });
  assert.deepEqual(result.decisions['copper/B'], { ruleId: 'r3', action: 'review' });
});

// Acceptance 2: both sides change the same rule's action to different values.
test('acceptance 2: same rule with different actions on both sides conflicts', () => {
  const base = [rule({ id: 'r1', action: 'accept' })];
  const local = [rule({ id: 'r1', action: 'reject' })];
  const remote = [rule({ id: 'r1', action: 'review' })];

  const result = mergeAll(DOMAIN, base, local, remote);
  assert.equal(result.conflicts.length > 0, true);
  const fieldConflict = result.conflicts.find((c) => c.type === 'field');
  assert.equal(fieldConflict.ruleId, 'r1');
  assert.deepEqual(fieldConflict.fields, [
    { field: 'action', base: 'accept', local: 'reject', remote: 'review' },
  ]);
});

// Acceptance 3: newly added rules (different ids) win the same feature with
// different actions -> semantic conflict even though structural merge is clean.
test('acceptance 3: new rules winning one feature with different actions is a semantic conflict', () => {
  const base = [rule({ id: 'r0', priority: 1, action: 'accept' })];
  const local = [
    rule({ id: 'r0', priority: 1, action: 'accept' }),
    rule({ id: 'r-local', priority: 10, action: 'reject' }),
  ];
  const remote = [
    rule({ id: 'r0', priority: 1, action: 'accept' }),
    rule({ id: 'r-remote', priority: 10, action: 'review' }),
  ];

  const result = mergeAll(DOMAIN, base, local, remote);
  const structural = result.conflicts.filter((c) => c.type !== 'semantic');
  assert.deepEqual(structural, []);

  const semantic = result.conflicts.filter((c) => c.type === 'semantic');
  assert.equal(semantic.length, 1);
  assert.equal(semantic[0].feature, 'steel/A');
  assert.deepEqual(semantic[0].local, { ruleId: 'r-local', action: 'reject' });
  assert.deepEqual(semantic[0].remote, { ruleId: 'r-remote', action: 'review' });
});

test('no semantic conflict when only one side changes the winning action', () => {
  const base = [rule({ id: 'r0', priority: 1, action: 'accept' })];
  const local = [rule({ id: 'r0', priority: 1, action: 'accept' })];
  const remote = [
    rule({ id: 'r0', priority: 1, action: 'accept' }),
    rule({ id: 'r-new', priority: 5, action: 'review' }),
  ];
  const result = mergeAll(DOMAIN, base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.decisions['steel/A'], { ruleId: 'r-new', action: 'review' });
});

test('structural merge: delete vs modify conflicts, delete vs keep deletes', () => {
  const base = [rule({ id: 'r1' }), rule({ id: 'r2' })];
  const local = [rule({ id: 'r2' })]; // r1 deleted, r2 kept unchanged
  const remote = [rule({ id: 'r1', fraction: 0.9 })]; // r1 modified, r2 deleted

  const { rules, conflicts } = mergeRules(base, local, remote);
  assert.deepEqual(rules, []); // r2 deleted on both sides
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, 'delete-modify');
  assert.equal(conflicts[0].ruleId, 'r1');
  assert.equal(conflicts[0].deletedBy, 'local');
});

test('decide: highest priority wins, ties break by lexicographic id, disabled rules ignored', () => {
  const feature = { material: 'steel', grade: 'A' };
  const rules = [
    rule({ id: 'b-rule', priority: 5, action: 'x' }),
    rule({ id: 'a-rule', priority: 5, action: 'y' }),
    rule({ id: 'z-high', priority: 9, enabled: false, action: 'z' }),
    rule({ id: 'other', material: 'copper', priority: 99, action: 'w' }),
  ];
  assert.deepEqual(decide(rules, feature), { ruleId: 'a-rule', action: 'y' });
  assert.equal(decide([], feature), null);
});

// Property test: with <= 8 features, enumerate every rule-enablement subset
// and compare decide() against an independent brute-force decision.
test('property: decisions match independent computation for all enablement subsets', () => {
  const domain = { materials: ['m1', 'm2'], grades: ['g1', 'g2'] }; // 4 features <= 8
  const features = featuresOf(domain);
  assert.equal(features.length <= 8, true);

  const templates = [
    rule({ id: 'k1', material: 'm1', grade: 'g1', priority: 3, action: 'a1' }),
    rule({ id: 'k2', material: 'm1', grade: 'g1', priority: 3, action: 'a2' }),
    rule({ id: 'k3', material: 'm1', grade: 'g1', priority: 7, action: 'a3' }),
    rule({ id: 'k4', material: 'm1', grade: 'g2', priority: 2, action: 'a4' }),
    rule({ id: 'k5', material: 'm2', grade: 'g1', priority: 4, action: 'a5' }),
    rule({ id: 'k6', material: 'm2', grade: 'g2', priority: 4, action: 'a6' }),
  ];

  // Independent reference: max priority first, then smallest id among ties.
  function referenceDecide(rules, feature) {
    const matching = rules.filter(
      (r) => r.enabled && r.material === feature.material && r.grade === feature.grade,
    );
    if (matching.length === 0) return null;
    const maxPriority = Math.max(...matching.map((r) => r.priority));
    const top = matching.filter((r) => r.priority === maxPriority);
    const winner = top.reduce((a, b) => (a.id <= b.id ? a : b));
    return { ruleId: winner.id, action: winner.action };
  }

  const subsets = 1 << templates.length;
  for (let mask = 0; mask < subsets; mask += 1) {
    const rules = templates.map((r, i) => ({ ...r, enabled: (mask & (1 << i)) !== 0 }));
    for (const feature of features) {
      assert.deepEqual(
        decide(rules, feature),
        referenceDecide(rules, feature),
        `mask=${mask.toString(2)} feature=${feature.material}/${feature.grade}`,
      );
    }
  }
});

test('validation: domain and rule legality including fraction range', () => {
  assert.equal(validateDomain(DOMAIN).length, 0);
  assert.equal(validateDomain({ materials: [], grades: ['A'] }).length > 0, true);
  assert.equal(validateDomain({ materials: ['a', 'a'], grades: ['A'] }).length > 0, true);
  assert.equal(validateDomain(null).length > 0, true);

  assert.equal(validateRules([rule({})], DOMAIN, 't').length, 0);
  assert.equal(validateRules([rule({ fraction: 1.5 })], DOMAIN, 't').length > 0, true);
  assert.equal(validateRules([rule({ fraction: -0.1 })], DOMAIN, 't').length > 0, true);
  assert.equal(
    validateRules([rule({ id: 'ra', fraction: 0 }), rule({ id: 'rb', fraction: 1 })], DOMAIN, 't').length,
    0,
  );
  assert.equal(validateRules([rule({ material: 'plastic' })], DOMAIN, 't').length > 0, true);
  assert.equal(validateRules([rule({}), rule({})], DOMAIN, 't').length > 0, true); // duplicate id
  assert.equal(validateRules([rule({ enabled: 'yes' })], DOMAIN, 't').length > 0, true);
});

// CLI integration tests.
const CLI = path.join(__dirname, '..', 'index.js');

function runCli(files, extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-rules-'));
  const paths = {};
  for (const [name, data] of Object.entries(files)) {
    paths[name] = path.join(dir, `${name}.json`);
    fs.writeFileSync(paths[name], JSON.stringify(data));
  }
  paths.out = path.join(dir, 'out.json');
  const result = spawnSync(
    process.execPath,
    [
      CLI,
      'merge-rules',
      '--domain', paths.domain,
      '--base', paths.base,
      '--local', paths.local,
      '--remote', paths.remote,
      '--out', paths.out,
      ...extraArgs,
    ],
    { encoding: 'utf8' },
  );
  const out = fs.existsSync(paths.out) ? JSON.parse(fs.readFileSync(paths.out, 'utf8')) : null;
  return { ...result, out };
}

test('cli: clean merge exits 0 and writes merged rules, conflicts, decisions', () => {
  const { status, out } = runCli({
    domain: DOMAIN,
    base: { rules: [rule({ id: 'r1' })] },
    local: { rules: [rule({ id: 'r1', fraction: 0.7 })] },
    remote: { rules: [rule({ id: 'r1', priority: 2 })] },
  });
  assert.equal(status, 0);
  assert.deepEqual(out.conflicts, []);
  assert.equal(out.rules.length, 1);
  assert.equal(out.rules[0].fraction, 0.7);
  assert.equal(out.rules[0].priority, 2);
  assert.deepEqual(out.decisions['steel/A'], { ruleId: 'r1', action: 'accept' });
});

test('cli: conflict exits 1 and reports conflicts', () => {
  const { status, out } = runCli({
    domain: DOMAIN,
    base: [rule({ id: 'r1', action: 'accept' })],
    local: [rule({ id: 'r1', action: 'reject' })],
    remote: [rule({ id: 'r1', action: 'review' })],
  });
  assert.equal(status, 1);
  assert.equal(out.conflicts.length > 0, true);
});

test('cli: semantic conflict from added rules exits 1', () => {
  const { status, out } = runCli({
    domain: DOMAIN,
    base: [rule({ id: 'r0', priority: 1, action: 'accept' })],
    local: [rule({ id: 'r0', priority: 1, action: 'accept' }), rule({ id: 'rl', priority: 9, action: 'reject' })],
    remote: [rule({ id: 'r0', priority: 1, action: 'accept' }), rule({ id: 'rr', priority: 9, action: 'review' })],
  });
  assert.equal(status, 1);
  assert.equal(out.conflicts.some((c) => c.type === 'semantic'), true);
});

test('cli: invalid fraction and invalid domain exit 2', () => {
  const badFraction = runCli({
    domain: DOMAIN,
    base: [rule({ id: 'r1', fraction: 2 })],
    local: [rule({ id: 'r1' })],
    remote: [rule({ id: 'r1' })],
  });
  assert.equal(badFraction.status, 2);
  assert.match(badFraction.stderr, /fraction/);

  const badDomain = runCli({
    domain: { materials: 'steel', grades: ['A'] },
    base: [rule({ id: 'r1' })],
    local: [rule({ id: 'r1' })],
    remote: [rule({ id: 'r1' })],
  });
  assert.equal(badDomain.status, 2);
});
