import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, baseRecipes, runWorld, runCli, readJsonl } from '../support/helpers.js';

function scenario(dir) {
  return runWorld(dir,
    baseRecipes({ forbidden: [['R1@1', 'R2@1']] }),
    [
      { ts: 1, op: 'grant', id: 'a1', level: 'factory', recipe: 'R1', version: 1 },
      { ts: 2, op: 'grant', id: 'a2', level: 'factory', recipe: 'R2', version: 1 },
    ],
    [
      { ts: 3, op: 'feed', reactor: 'K1', recipe: 'R1', version: 1 },
      { ts: 4, op: 'feed', reactor: 'K1', recipe: 'R2', version: 1 },
    ]);
}

test('audit: per-reactor replay proves every allowed feed (exit 0)', () => {
  const dir = tmpdir();
  const { res, recipesPath, approvalsPath, attemptsPath } = scenario(dir);
  assert.equal(res.status, 0, res.stderr);
  const audit = runCli(['audit', '--recipes', recipesPath, '--approvals', approvalsPath,
    '--attempts', attemptsPath, '--reactor', 'K1']);
  assert.equal(audit.status, 0);
  // stdio capture is unavailable in the sandbox; verify via the library too.
});

test('audit library: every allowed feed has valid approval and no forbidden hit', async () => {
  const { loadRecipes, loadJsonl, mergeEvents } = await import('../src/model.js');
  const { auditReactor } = await import('../src/audit.js');
  const dir = tmpdir();
  const { recipesPath, approvalsPath, attemptsPath } = scenario(dir);
  const model = loadRecipes(recipesPath);
  const events = mergeEvents(loadJsonl(approvalsPath), loadJsonl(attemptsPath));
  const report = auditReactor(model, events, 'K1');
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0].approval, 'a1');
  assert.equal(report.checks[0].permitOk, true);
  assert.equal(report.checks[0].forbiddenOk, true);
  // The denied forbidden feed appears in the replay with its conflict.
  const denied = report.replay.filter((e) => e.op === 'feed' && e.decision === 'deny');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].reason, 'forbidden');
  assert.deepEqual(denied[0].conflicts, ['R1@1']);
});

test('counterexample: minimal approval set for a dangerous feed is written to proof file', () => {
  const dir = tmpdir();
  const { res, recipesPath, approvalsPath, attemptsPath, proofdir } = scenario(dir);
  assert.equal(res.status, 0, res.stderr);
  const outPath = path.join(proofdir, 'counterexample.json');
  const ce = runCli(['counterexample', '--recipes', recipesPath, '--approvals', approvalsPath,
    '--attempts', attemptsPath, '--reactor', 'K1', '--recipe', 'R2', '--version', '1', '--out', outPath]);
  assert.equal(ce.status, 0);
  const output = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(output.dangerous, true);
  assert.deepEqual(output.conflicts, ['R1@1']);
  // The factory grant a2 alone is the minimal set that would (wrongly) allow it.
  assert.deepEqual(output.minimalApprovals, ['a2']);
  assert.equal(output.size, 1);
  // The constraint layer still denies the feed in the real interpreter.
  assert.equal(output.constraintHolds, true);
  assert.equal(output.effectiveDecision, 'deny');
  assert.equal(output.effectiveReason, 'forbidden');
  assert.deepEqual(output.reactorContents, ['R1@1']);
});

test('counterexample: no candidate approvals means no wrongful-allow set', () => {
  const dir = tmpdir();
  const { res, recipesPath, approvalsPath, attemptsPath, proofdir } = runWorld(dir,
    baseRecipes({ forbidden: [['R1@1', 'R2@1']] }),
    [{ ts: 1, op: 'grant', id: 'a1', level: 'factory', recipe: 'R1', version: 1 }],
    [{ ts: 2, op: 'feed', reactor: 'K1', recipe: 'R1', version: 1 }]);
  assert.equal(res.status, 0, res.stderr);
  const outPath = path.join(proofdir, 'counterexample.json');
  const ce = runCli(['counterexample', '--recipes', recipesPath, '--approvals', approvalsPath,
    '--attempts', attemptsPath, '--reactor', 'K1', '--recipe', 'R2', '--version', '1', '--out', outPath]);
  assert.equal(ce.status, 0);
  const output = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(output.dangerous, true);
  assert.equal(output.minimalApprovals, null);
  assert.equal(output.effectiveReason, 'no-approval');
});

test('run: allow.jsonl records one line per feed attempt', () => {
  const dir = tmpdir();
  const { res, out } = scenario(dir);
  assert.equal(res.status, 0, res.stderr);
  const lines = readJsonl(out);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.decision), ['allow', 'deny']);
});
