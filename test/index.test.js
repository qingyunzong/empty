'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  normalizeTree,
  parsePath,
  stateHash,
  effectiveAt,
  leafEffectiveStates,
} = require('../lib/tree');
const { applyPatch, diffTrees } = require('../lib/patch');
const { mergePatches, MergeConflict } = require('../lib/merge');
const { loadHistory, squash } = require('../lib/history');

const CLI = path.join(__dirname, '..', 'index.js');

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function tmpFile(name, value) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alertcfg-')), name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function sampleBase() {
  return {
    thresholds: { temp: 50, hum: 80 },
    children: {
      site: {
        thresholds: { temp: 60 },
        children: {
          rack: { thresholds: {}, children: {} },
        },
      },
    },
  };
}

test('merge: disjoint parent/child overrides auto-merge with correct inheritance', () => {
  const base = sampleBase();
  const ours = { set: { site: { hum: 70 } } };
  const theirs = { set: { 'site/rack': { press: 3 } } };

  const merged = mergePatches(ours, theirs);
  assert.deepEqual(merged.set.site, { hum: 70 });
  assert.deepEqual(merged.set['site/rack'], { press: 3 });

  const tree = applyPatch(base, merged);
  assert.deepEqual(effectiveAt(tree, parsePath('site/rack')), {
    temp: 60, // inherited from nearest ancestor "site"
    hum: 70, // merged onto parent, inherited by rack
    press: 3, // merged onto the leaf itself
  });
  assert.deepEqual(effectiveAt(tree, parsePath('site')), { temp: 60, hum: 70 });
});

test('merge: same path same key with different values conflicts', () => {
  assert.throws(
    () => mergePatches({ set: { site: { temp: 1 } } }, { set: { site: { temp: 2 } } }),
    MergeConflict,
  );
  const merged = mergePatches({ set: { site: { temp: 1 } } }, { set: { site: { temp: 1 } } });
  assert.deepEqual(merged.set.site, { temp: 1 });
});

test('merge: deleting a parent vs modifying a child is a structural conflict', () => {
  assert.throws(
    () => mergePatches({ deleteNodes: ['site'] }, { set: { 'site/rack': { temp: 1 } } }),
    (error) => {
      assert.ok(error instanceof MergeConflict);
      assert.ok(error.conflicts.some((c) => c.type === 'structural'));
      return true;
    },
  );
  assert.throws(
    () => mergePatches({ set: { 'site/rack': { temp: 1 } } }, { deleteNodes: ['site'] }),
    MergeConflict,
  );
  const merged = mergePatches({ deleteNodes: ['site'] }, { deleteNodes: ['site'] });
  assert.deepEqual(merged.deleteNodes, ['site']);
});

function buildRepo() {
  return {
    base: sampleBase(),
    commits: [
      { patch: { set: { site: { temp: 61 } } } },
      { patch: { set: { 'site/rack': { press: 5 } } } },
      { patch: { unset: { site: ['temp'] }, set: { '': { hum: 75 } } } },
      { sealed: true, patch: { set: { site: { co2: 900 } } } },
      { patch: { set: { 'site/rack': { press: 6 } } } },
    ],
  };
}

test('squash: effective config, root stateHash and old->new mapping are preserved', () => {
  const repo = buildRepo();
  const before = loadHistory(repo);
  const from = before.commits[0].hash;
  const to = before.commits[2].hash;

  const result = squash(repo, from, to);
  const after = loadHistory(result.repo);

  assert.equal(after.commits.length, before.commits.length - 2);

  const originalTip = before.states[before.states.length - 1];
  const squashedTip = after.states[after.states.length - 1];
  assert.deepEqual(leafEffectiveStates(squashedTip), leafEffectiveStates(originalTip));
  assert.equal(stateHash(squashedTip), stateHash(originalTip));

  const squashedState = after.states[1];
  assert.equal(stateHash(squashedState), before.commits[2].stateHash);
  assert.deepEqual(
    leafEffectiveStates(squashedState),
    leafEffectiveStates(before.states[3]),
  );

  const mapping = result.repo.squashMap;
  for (let index = 0; index <= 2; index += 1) {
    assert.equal(mapping[before.commits[index].hash], result.squashedHash);
  }
  for (let index = 3; index < before.commits.length; index += 1) {
    const mapped = mapping[before.commits[index].hash];
    assert.ok(mapped, 'every commit after the range is remapped');
    assert.notEqual(mapped, before.commits[index].hash, 'descendant hashes change');
    assert.equal(mapped, after.commits[index - 2].hash);
  }

  assert.equal(after.commits[0].sealed, false);
  assert.equal(after.commits[1].sealed, true, 'sealed flags survive rehashing');
  assert.equal(after.commits[2].sealed, false);
});

test('squash: sealed boundary cannot be crossed and bad ranges exit 2', () => {
  const repo = buildRepo();
  const { commits } = loadHistory(repo);
  assert.throws(() => squash(repo, commits[2].hash, commits[3].hash), /sealed/);
  assert.throws(() => squash(repo, 'nope', commits[1].hash), /unknown --from/);
  assert.throws(() => squash(repo, commits[2].hash, commits[0].hash), /after/);
});

test('cli: squash writes output, keeps input untouched, exit codes 0/2', () => {
  const repo = buildRepo();
  const repoFile = tmpFile('repo.json', repo);
  const outFile = path.join(path.dirname(repoFile), 'out.json');
  const before = loadHistory(repo);

  const ok = runCli(['squash', '--repo', repoFile, '--from', before.commits[0].hash, '--to', before.commits[2].hash, '--out', outFile]);
  assert.equal(ok.status, 0, ok.stderr);
  const written = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(written.commits.length, 3);
  assert.ok(fs.existsSync(repoFile));
  assert.deepEqual(JSON.parse(fs.readFileSync(repoFile, 'utf8')), repo, 'input history preserved');

  const sealed = runCli(['squash', '--repo', repoFile, '--from', before.commits[0].hash, '--to', before.commits[3].hash, '--out', outFile]);
  assert.equal(sealed.status, 1 + 1);
  assert.match(sealed.stderr, /sealed/);

  const missing = runCli(['squash', '--repo', repoFile, '--from', 'deadbeef', '--to', before.commits[1].hash, '--out', outFile]);
  assert.equal(missing.status, 2);
});

test('cli: merge exits 0 on clean merge and 1 on structural conflict', () => {
  const repo = { base: sampleBase(), commits: [{ patch: { set: { '': { alt: 100 } } } }] };
  const repoFile = tmpFile('repo.json', repo);
  const { commits } = loadHistory(repo);
  const outFile = path.join(path.dirname(repoFile), 'merged.json');

  const leftFile = tmpFile('left.json', { set: { site: { hum: 70 } } });
  const rightFile = tmpFile('right.json', { set: { 'site/rack': { press: 3 } } });
  const ok = runCli(['merge', '--repo', repoFile, '--base', commits[0].hash, '--left', leftFile, '--right', rightFile, '--out', outFile]);
  assert.equal(ok.status, 0, ok.stderr);
  const merged = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.deepEqual(effectiveAt(merged.tree, parsePath('site/rack')), {
    temp: 60,
    hum: 70,
    press: 3,
    alt: 100,
  });

  const delFile = tmpFile('del.json', { deleteNodes: ['site'] });
  const modFile = tmpFile('mod.json', { set: { 'site/rack': { temp: 1 } } });
  const bad = runCli(['merge', '--repo', repoFile, '--base', commits[0].hash, '--left', delFile, '--right', modFile, '--out', outFile]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /conflict/);
});

// Independent inheritance oracle: for each leaf and key, walk from the leaf
// up to the root and take the first node that overrides the key.
function oracleLeafStates(tree) {
  const result = {};
  const walk = (node, segments, chain) => {
    const here = [...chain, node];
    const names = Object.keys(node.children || {});
    if (names.length === 0) {
      const path = segments.join('/');
      const effective = {};
      const keys = new Set();
      for (const ancestor of here) {
        for (const key of Object.keys(ancestor.thresholds || {})) keys.add(key);
      }
      for (const key of keys) {
        for (let index = here.length - 1; index >= 0; index -= 1) {
          if (key in (here[index].thresholds || {})) {
            effective[key] = here[index].thresholds[key];
            break;
          }
        }
      }
      result[path] = effective;
      return;
    }
    for (const name of names) walk(node.children[name], [...segments, name], here);
  };
  walk(tree, [], []);
  return result;
}

test('inheritance: enumerate all override subsets (<=3 levels, <=3 keys) vs oracle', () => {
  const shapes = [
    ['root'],
    ['root', 'root/a', 'root/b'],
    ['root', 'root/a', 'root/a/b'],
    ['root', 'root/a', 'root/b', 'root/b/c'],
  ];
  const keys = ['k1', 'k2', 'k3'];

  for (const nodePaths of shapes) {
    const nodeCount = nodePaths.length;
    const combos = 1 << (nodeCount * keys.length);
    for (let mask = 0; mask < combos; mask += 1) {
      const tree = { thresholds: {}, children: {} };
      const nodes = {};
      for (const p of nodePaths) {
        const segments = p === 'root' ? [] : p.slice(5).split('/');
        let node = tree;
        for (const segment of segments) {
          node.children[segment] = node.children[segment] || { thresholds: {}, children: {} };
          node = node.children[segment];
        }
        nodes[p] = node;
      }
      let bit = 0;
      for (const p of nodePaths) {
        for (const key of keys) {
          if (mask & (1 << bit)) nodes[p].thresholds[key] = `${p}:${key}`;
          bit += 1;
        }
      }
      const normalized = normalizeTree(tree);
      assert.deepEqual(
        leafEffectiveStates(normalized),
        oracleLeafStates(normalized),
        `shape=${nodePaths.join(',')} mask=${mask}`,
      );
    }
  }
});

test('diffTrees/applyPatch round-trip preserves stateHash', () => {
  const repo = buildRepo();
  const { base, commits, states } = loadHistory(repo);
  for (let index = 0; index < commits.length; index += 1) {
    const patch = diffTrees(states[index], states[index + 1]);
    const replayed = applyPatch(base === states[index] ? states[index] : states[index], patch);
    assert.equal(stateHash(replayed), commits[index].stateHash);
  }
});
