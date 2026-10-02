import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rewriteHistory, RewriteAbort, Tokenizer } from '../src/redact.js';
import { replay, verifyHistory } from '../src/history.js';
import { run } from '../src/cli.js';

const RULES = [
  { name: 'subject-id', pattern: 'SUBJ-\\d{3}' },
  { name: 'email', pattern: '[\\w.]+@[\\w.]+' },
];

function sampleHistory() {
  return [
    {
      author: 'alice',
      message: 'import cohort for SUBJ-001',
      patch: [
        {
          file: 'cohort.csv',
          hunks: [
            { op: 'insert', context: '', position: 'after', text: 'id,email\nSUBJ-001,a@lab.org\nSUBJ-002,b@lab.org\n' },
          ],
        },
      ],
    },
    {
      author: 'bob',
      message: 'correct contact for SUBJ-002',
      patch: [
        {
          file: 'cohort.csv',
          hunks: [
            { op: 'replace', old: 'SUBJ-002,b@lab.org', new: 'SUBJ-002,b2@lab.org' },
          ],
        },
        {
          file: 'notes.txt',
          hunks: [
            { op: 'insert', context: '', position: 'after', text: 'follow-up with SUBJ-001 and SUBJ-003\n' },
          ],
        },
      ],
    },
    {
      author: 'alice',
      message: 'drop stale row',
      patch: [
        {
          file: 'cohort.csv',
          hunks: [
            { op: 'delete', old: 'SUBJ-002,b2@lab.org\n' },
          ],
        },
      ],
    },
  ];
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

test('multi-version history: same value gets the same stable token everywhere', () => {
  const commits = sampleHistory();
  const { commits: rewritten, manifest, tokenMap } = rewriteHistory(commits, RULES);

  // Every recorded commit hash of the rewritten history replays cleanly.
  assert.deepEqual(verifyHistory(rewritten), []);

  // Same original value -> same token across versions, patches and messages.
  const tokenFor = new Map(tokenMap.map(({ value, token }) => [value, token]));
  assert.ok(tokenFor.has('SUBJ-001'));
  const allText = collectStrings(rewritten).join('\n');
  assert.ok(!allText.includes('SUBJ-001'), 'no plaintext subject id remains');
  assert.ok(!allText.includes('a@lab.org'), 'no plaintext email remains');
  assert.ok(allText.includes(tokenFor.get('SUBJ-001')), 'token present in rewritten output');

  // The message hit is replaced with the same token used in the patch.
  assert.ok(rewritten[0].message.includes(tokenFor.get('SUBJ-001')));
  assert.ok(!rewritten[0].message.includes('SUBJ-001'));

  // Token appears identically across commit patches and messages.
  const patchAndMessageText = collectStrings(rewritten.map((c) => [c.patch, c.message])).join('\n');
  const occurrences = patchAndMessageText.split(tokenFor.get('SUBJ-001')).length - 1;
  assert.ok(occurrences >= 3, `stable token reused across commits (saw ${occurrences})`);

  // Final replayed state equals the original final state under projection.
  const originalFinal = replay(commits).store;
  const rewrittenFinal = replay(rewritten).store;
  const projector = new Tokenizer(RULES);
  for (const [name, content] of Object.entries(originalFinal)) {
    assert.equal(rewrittenFinal[name], projector.redactText(content), `projection equality for ${name}`);
  }

  // Manifest: full old->new mapping plus invalidation proof of the old tip.
  assert.equal(manifest.commits.length, commits.length);
  const originalHashes = replay(commits).results.map((r) => r.hash);
  manifest.commits.forEach((m, i) => {
    assert.equal(m.oldHash, originalHashes[i]);
    assert.equal(m.newHash, rewritten[i].hash);
    assert.notEqual(m.oldHash, m.newHash);
  });
  assert.equal(manifest.invalidation.oldTip, originalHashes.at(-1));
  assert.equal(manifest.invalidation.newTip, rewritten.at(-1).hash);
  assert.match(manifest.invalidation.proofHash, /^[0-9a-f]{64}$/);
});

test('conflicting tokens for two distinct values abort the rewrite', () => {
  const commits = sampleHistory();
  assert.throws(
    () => rewriteHistory(commits, RULES, { tokenize: () => 'COLLIDING-TOKEN' }),
    (err) => err instanceof RewriteAbort && err.reason === 'token-collision',
  );
});

test('patch context that cannot be located after substitution aborts', () => {
  const commits = [
    {
      author: 'alice',
      message: 'import',
      patch: [
        { file: 'data.txt', hunks: [{ op: 'insert', context: '', position: 'after', text: 'row SUBJ-001 end\n' }] },
      ],
    },
    {
      author: 'bob',
      message: 'edit',
      // The anchor is only a prefix of the sensitive value, so the rule does
      // not match inside the hunk; after the content is tokenized the anchor
      // no longer exists and the patch cannot be located.
      patch: [
        { file: 'data.txt', hunks: [{ op: 'replace', old: 'SUBJ-00', new: 'SUBJ-009' }] },
      ],
    },
  ];
  assert.throws(
    () => rewriteHistory(commits, RULES),
    (err) => err instanceof RewriteAbort && err.reason === 'patch-context',
  );
});

test('history without sensitive values still gets hashes recomputed per spec', () => {
  const commits = [
    {
      author: 'alice',
      message: 'initial public dataset',
      patch: [
        { file: 'public.csv', hunks: [{ op: 'insert', context: '', position: 'after', text: 'a,b\n1,2\n' }] },
      ],
    },
    {
      author: 'bob',
      message: 'extend',
      patch: [
        { file: 'public.csv', hunks: [{ op: 'replace', old: '1,2', new: '1,3' }] },
      ],
    },
  ];
  const { commits: rewritten, manifest, tokenMap } = rewriteHistory(commits, RULES);

  assert.equal(tokenMap.length, 0);
  const expected = replay(commits);
  rewritten.forEach((commit, i) => {
    assert.equal(commit.hash, expected.results[i].hash, 'hash recomputed per specification');
    assert.deepEqual(commit.files, expected.results[i].files);
    // No sensitive values: content is byte-identical to the original.
    assert.deepEqual(commit.patch, commits[i].patch);
    assert.equal(commit.message, commits[i].message);
  });
  assert.deepEqual(verifyHistory(rewritten), []);
  assert.equal(manifest.oldTip, expected.results.at(-1).hash);
  assert.equal(manifest.newTip, expected.results.at(-1).hash);
});

test('control: enumerate every replacement bijection over <=3 values', () => {
  const values = ['SUBJ-001', 'SUBJ-002', 'SUBJ-003'];
  const tokens = ['TOK-X', 'TOK-Y', 'TOK-Z'];
  const commits = [
    {
      author: 'alice',
      message: 'cohort SUBJ-001 SUBJ-002 SUBJ-003',
      patch: [
        {
          file: 'c.txt',
          hunks: [{ op: 'insert', context: '', position: 'after', text: 'SUBJ-001;SUBJ-002;SUBJ-003\n' }],
        },
      ],
    },
    {
      author: 'bob',
      message: 'update SUBJ-002',
      patch: [
        { file: 'c.txt', hunks: [{ op: 'replace', old: 'SUBJ-002', new: 'SUBJ-002 (reviewed)' }] },
      ],
    },
  ];

  function* permutations(items) {
    if (items.length <= 1) { yield items; return; }
    for (let i = 0; i < items.length; i += 1) {
      for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) {
        yield [items[i], ...rest];
      }
    }
  }

  const originalFinal = replay(commits).store;
  let checked = 0;
  for (const perm of permutations(tokens)) {
    const bijection = new Map(values.map((v, i) => [v, perm[i]]));
    const tokenize = (v) => {
      assert.ok(bijection.has(v), `unexpected value ${v}`);
      return bijection.get(v);
    };
    const { commits: rewritten, tokenMap } = rewriteHistory(commits, RULES, { tokenize });

    // The recorded token map is exactly the enumerated bijection.
    assert.equal(tokenMap.length, values.length);
    for (const { value, token } of tokenMap) assert.equal(token, bijection.get(value));

    // Replayed final state equals the original final state projected through
    // this specific bijection.
    const rewrittenFinal = replay(rewritten).store;
    for (const [name, content] of Object.entries(originalFinal)) {
      let projected = content;
      for (const [value, token] of bijection) projected = projected.split(value).join(token);
      assert.equal(rewrittenFinal[name], projected);
    }
    checked += 1;
  }
  assert.equal(checked, 6, 'all 3! bijections enumerated');
});

// ---------- CLI integration ----------

function makeWorkspace() {
  return mkdtempSync(join(tmpdir(), 'history-redact-'));
}

function runCli(args) {
  const lines = { stdout: [], stderr: [] };
  const status = run(args, {
    stdout: (line) => lines.stdout.push(line),
    stderr: (line) => lines.stderr.push(line),
  });
  return { status, stdout: lines.stdout.join('\n'), stderr: lines.stderr.join('\n') };
}

test('CLI rewrite: writes rewritten history + manifest, verify passes', () => {
  const dir = makeWorkspace();
  const historyPath = join(dir, 'history.json');
  const rulesPath = join(dir, 'rules.json');
  writeFileSync(historyPath, JSON.stringify({ commits: sampleHistory() }));
  writeFileSync(rulesPath, JSON.stringify(RULES));

  const res = runCli(['rewrite', '--history', historyPath, '--rules', rulesPath]);
  assert.equal(res.status, 0, res.stderr);

  const outHistory = join(dir, 'history.rewritten.json');
  const outManifest = join(dir, 'history.manifest.json');
  assert.ok(existsSync(outHistory));
  assert.ok(existsSync(outManifest));

  const manifest = JSON.parse(readFileSync(outManifest, 'utf8'));
  assert.equal(manifest.commits.length, 3);
  assert.ok(manifest.invalidation.proofHash);
  assert.ok(manifest.tokens.length > 0);

  const verify = runCli(['verify', '--history', outHistory]);
  assert.equal(verify.status, 0, verify.stderr);
});

test('CLI rewrite: token collision exits 2 and leaves files untouched', () => {
  const dir = makeWorkspace();
  const historyPath = join(dir, 'history.json');
  const rulesPath = join(dir, 'rules.json');
  const original = JSON.stringify({ commits: sampleHistory() });
  writeFileSync(historyPath, original);
  // One rule with a fixed token matches two distinct values -> collision.
  writeFileSync(rulesPath, JSON.stringify([{ name: 'fixed', values: ['SUBJ-001', 'SUBJ-002'], token: 'SAME' }]));

  const res = runCli(['rewrite', '--history', historyPath, '--rules', rulesPath]);
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /token collision/);
  assert.equal(readFileSync(historyPath, 'utf8'), original, 'original history untouched');
  assert.deepEqual(readdirSync(dir).sort(), ['history.json', 'rules.json'], 'no output files written');
});

test('CLI rewrite: unlocatable patch context exits 2 and leaves files untouched', () => {
  const dir = makeWorkspace();
  const historyPath = join(dir, 'history.json');
  const rulesPath = join(dir, 'rules.json');
  const commits = [
    {
      author: 'a', message: 'm',
      patch: [{ file: 'd.txt', hunks: [{ op: 'insert', context: '', position: 'after', text: 'x SUBJ-001 y\n' }] }],
    },
    {
      author: 'b', message: 'm',
      patch: [{ file: 'd.txt', hunks: [{ op: 'replace', old: 'SUBJ-00', new: 'SUBJ-009' }] }],
    },
  ];
  const original = JSON.stringify({ commits });
  writeFileSync(historyPath, original);
  writeFileSync(rulesPath, JSON.stringify(RULES));

  const res = runCli(['rewrite', '--history', historyPath, '--rules', rulesPath]);
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /patch context/);
  assert.equal(readFileSync(historyPath, 'utf8'), original);
  assert.deepEqual(readdirSync(dir).sort(), ['history.json', 'rules.json']);
});
