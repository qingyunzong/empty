'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AbortRewrite,
  sha256hex,
  contentHashOf,
  computeCommitId,
  applyPatch,
  buildTokenMap,
  redactText,
  rewriteHistory,
} = require('../src/redact');
const { main: cliMain } = require('../bin/redact-history');

const RULES = [{ pattern: 'SECRET-[A-Z]+-[0-9]+' }];

function replay(repo) {
  let content = repo.initial;
  for (const commit of repo.commits) {
    content = applyPatch(content, commit.patch);
    if (typeof commit.contentHash === 'string') {
      assert.equal(contentHashOf(content), commit.contentHash, 'content hash matches replay');
    }
  }
  return content;
}

function runCli(argv) {
  const logs = [];
  const errors = [];
  const code = cliMain(argv, {
    log: (msg) => logs.push(String(msg)),
    error: (msg) => errors.push(String(msg)),
  });
  return { code, logs, errors };
}

function findCollidingPair(tokenLength) {
  const byPrefix = new Map();
  for (let i = 0; i < 65536; i += 1) {
    const value = 'KEY-' + i;
    const prefix = sha256hex(value).slice(0, tokenLength);
    if (byPrefix.has(prefix)) return [byPrefix.get(prefix), value];
    byPrefix.set(prefix, value);
  }
  throw new Error('no collision found; widen the search');
}

function sampleRepo() {
  return {
    initial: 'name,secret\nalice,SECRET-ALICE-1\n',
    commits: [
      {
        id: 'old-id-1',
        parent: null,
        author: 'alice',
        note: 'imported row for SECRET-ALICE-1',
        patch: {
          file: 'data.csv',
          hunks: [{
            before: 'alice,SECRET-ALICE-1\n',
            remove: '',
            add: 'bob,SECRET-BOB-2\n',
            after: '',
          }],
        },
      },
      {
        id: 'old-id-2',
        parent: 'old-id-1',
        author: 'bob',
        note: 'rotated SECRET-BOB-2, alice key unchanged',
        patch: {
          file: 'data.csv',
          hunks: [{
            before: 'alice,SECRET-ALICE-1\n',
            remove: 'bob,SECRET-BOB-2\n',
            add: 'bob,SECRET-BOB-2\n# eof\n',
            after: '',
          }],
        },
      },
      {
        id: 'old-id-3',
        parent: 'old-id-2',
        author: 'carol',
        note: 'no secrets in this note',
        patch: {
          file: 'data.csv',
          hunks: [{
            before: 'name,secret\n',
            remove: '',
            add: '',
            after: 'alice,SECRET-ALICE-1\n',
          }],
        },
      },
    ],
  };
}

test('multi-version rewrite uses one stable token per value everywhere', () => {
  const repo = sampleRepo();
  const originalFinal = replay({ initial: repo.initial, commits: repo.commits.map((c) => ({
    ...c,
    contentHash: null,
  })) });

  const { repo: rewritten, proof, tokenMap } = rewriteHistory(repo, RULES);

  assert.equal(tokenMap.size, 2);
  const aliceToken = tokenMap.get('SECRET-ALICE-1');
  const bobToken = tokenMap.get('SECRET-BOB-2');
  assert.ok(aliceToken && bobToken && aliceToken !== bobToken);

  assert.ok(rewritten.commits[0].note.includes(aliceToken));
  assert.ok(!rewritten.commits[0].note.includes('SECRET-ALICE-1'));
  assert.ok(rewritten.commits[1].note.includes(bobToken));
  assert.ok(rewritten.commits[2].patch.hunks[0].after.includes(aliceToken));
  assert.ok(rewritten.initial.includes(aliceToken));

  const rewrittenFinal = replay(rewritten);
  assert.equal(rewrittenFinal, redactText(originalFinal, tokenMap));
  assert.ok(!rewrittenFinal.includes('SECRET-'));

  assert.equal(proof.commitMap.length, 3);
  assert.deepEqual(proof.commitMap.map((e) => e.old), ['old-id-1', 'old-id-2', 'old-id-3']);
  assert.equal(proof.oldHead, 'old-id-3');
  assert.equal(proof.newHead, rewritten.commits[2].id);
  assert.notEqual(proof.oldHead, proof.newHead);
  assert.equal(proof.invalidatedHistoryHash, sha256hex(require('../src/redact').canonical(repo.commits)));
  assert.equal(proof.tokens.length, 2);
  for (const entry of proof.tokens) {
    assert.match(entry.token, /^REDACTED-[0-9a-f]{12}$/);
    assert.match(entry.valueSha256, /^[0-9a-f]{64}$/);
  }

  for (let i = 0; i < rewritten.commits.length; i += 1) {
    const c = rewritten.commits[i];
    assert.equal(c.parent, i === 0 ? null : rewritten.commits[i - 1].id);
    assert.equal(c.id, computeCommitId(c));
  }
});

test('distinct values colliding on one token abort with exit code 2', () => {
  const pair = findCollidingPair(1);

  const repo = {
    initial: pair[0] + '\n' + pair[1] + '\n',
    commits: [],
  };
  assert.throws(
    () => rewriteHistory(repo, [{ pattern: 'KEY-[0-9]+' }], { tokenLength: 1 }),
    (err) => err instanceof AbortRewrite && err.reason === 'token-collision' && err.exitCode === 2,
  );
});

test('no sensitive values: hashes are still recomputed per spec', () => {
  const repo = {
    initial: 'alpha\n',
    commits: [
      {
        id: 'bogus-id-1',
        parent: null,
        author: 'alice',
        note: 'add beta',
        patch: { file: 'f.txt', hunks: [{ before: 'alpha\n', remove: '', add: 'beta\n', after: '' }] },
      },
      {
        id: 'bogus-id-2',
        parent: 'bogus-id-1',
        author: 'bob',
        note: 'rename nothing',
        patch: { file: 'f.txt', hunks: [{ before: 'beta\n', remove: '', add: 'gamma\n', after: '' }] },
      },
    ],
  };

  const { repo: rewritten, proof, tokenMap } = rewriteHistory(repo, RULES);

  assert.equal(tokenMap.size, 0);
  assert.equal(replay(rewritten), 'alpha\nbeta\ngamma\n');
  assert.notDeepEqual(rewritten.commits.map((c) => c.id), ['bogus-id-1', 'bogus-id-2']);
  for (let i = 0; i < rewritten.commits.length; i += 1) {
    const c = rewritten.commits[i];
    assert.equal(c.parent, i === 0 ? null : rewritten.commits[i - 1].id);
    assert.equal(c.id, computeCommitId(c), 'id recomputed per canonical spec');
    assert.equal(c.contentHash, contentHashOf(i === 0 ? 'alpha\nbeta\n' : 'alpha\nbeta\ngamma\n'));
  }
  assert.equal(proof.redactedValueCount, 0);
  assert.equal(proof.newHead, rewritten.commits[1].id);
});

test('replacement map over <= 3 values is a bijection (reference enumeration)', () => {
  const values = ['SECRET-A-1', 'SECRET-B-2', 'SECRET-C-3'];
  assert.ok(values.length <= 3);
  const tokenMap = buildTokenMap(values, 12);

  assert.equal(tokenMap.size, values.length);
  const tokens = values.map((v) => tokenMap.get(v));
  assert.equal(new Set(tokens).size, values.length, 'tokens are pairwise distinct');

  for (const value of values) {
    assert.equal(redactText(value, tokenMap), tokenMap.get(value));
    assert.equal(redactText('x' + value + 'y' + value, tokenMap),
      'x' + tokenMap.get(value) + 'y' + tokenMap.get(value));
  }
  for (const token of tokens) {
    assert.ok(!values.includes(token), 'no token equals a source value');
  }
});

test('unlocatable patch context aborts and does not modify input', () => {
  const repo = sampleRepo();
  const snapshot = JSON.stringify(repo);
  repo.commits[1].patch.hunks[0].before = 'CONTEXT THAT DOES NOT EXIST\n';

  assert.throws(
    () => rewriteHistory(repo, RULES),
    (err) => err instanceof AbortRewrite && err.reason === 'context-not-found' && err.exitCode === 2,
  );
  repo.commits[1].patch.hunks[0].before = 'alice,SECRET-ALICE-1\n';
  assert.equal(JSON.stringify(repo), snapshot, 'input repo object untouched');
});

test('CLI exits 2 on token collision and writes no output files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-test-'));
  const pair = findCollidingPair(1);
  const repoPath = path.join(dir, 'repo.json');
  const rulesPath = path.join(dir, 'rules.json');
  const outPath = path.join(dir, 'out.json');
  const proofPath = path.join(dir, 'proof.json');
  fs.writeFileSync(repoPath, JSON.stringify({ initial: pair.join('\n') + '\n', commits: [] }));
  fs.writeFileSync(rulesPath, JSON.stringify({ rules: [{ pattern: 'KEY-[0-9]+' }] }));

  const run = runCli(['rewrite',
    '--repo', repoPath, '--rules', rulesPath,
    '--out', outPath, '--proof', proofPath, '--token-length', '1']);

  assert.equal(run.code, 2, run.errors.join('\n'));
  assert.match(run.errors.join('\n'), /token-collision/);
  assert.ok(!fs.existsSync(outPath), 'no rewritten repo written on abort');
  assert.ok(!fs.existsSync(proofPath), 'no proof written on abort');
});

test('CLI rewrites a repo end to end with exit code 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-test-'));
  const repoPath = path.join(dir, 'repo.json');
  const rulesPath = path.join(dir, 'rules.json');
  const outPath = path.join(dir, 'out.json');
  const proofPath = path.join(dir, 'proof.json');
  fs.writeFileSync(repoPath, JSON.stringify(sampleRepo()));
  fs.writeFileSync(rulesPath, JSON.stringify({ rules: RULES }));

  const run = runCli(['rewrite',
    '--repo', repoPath, '--rules', rulesPath,
    '--out', outPath, '--proof', proofPath]);

  assert.equal(run.code, 0, run.errors.join('\n'));
  const rewritten = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  const finalContent = replay(rewritten);
  assert.ok(!finalContent.includes('SECRET-'));
  assert.equal(proof.newHead, rewritten.commits[rewritten.commits.length - 1].id);
});
