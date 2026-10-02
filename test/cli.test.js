'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { main } = require('../bin/explree');

const EXAMPLES = path.join(__dirname, '..', 'examples');

function runCli(...args) {
  const out = [];
  const err = [];
  const status = main(args, { stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('CLI prints a safety certificate for a safe scenario', (t) => {
  const res = runCli(path.join(EXAMPLES, 'tree.json'), path.join(EXAMPLES, 'actors.json'));
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.safe, true);
  assert.equal(out.certificate.interleavings, 6);
  assert.match(out.certificate.hash, /^[0-9a-f]{64}$/);
  t.diagnostic(`certificate ${JSON.stringify(out.certificate)}`);
});

test('CLI prints the lexicographically smallest counterexample with chain and hash', (t) => {
  const res = runCli(path.join(EXAMPLES, 'tree.json'), path.join(EXAMPLES, 'actors-counterexample.json'));
  assert.equal(res.status, 1, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.safe, false);
  const cx = out.counterexample;
  assert.equal(cx.failure.kind, 'unexpected_reject');
  assert.equal(cx.failure.code, 'INSUFFICIENT_BALANCE');
  assert.deepEqual(cx.sequence.map((s) => s.actor), ['alice', 'bob']);
  assert.deepEqual(cx.ancestorChain.map((n) => n.id), ['root', 'ops']);
  assert.equal(cx.ancestorChain[0].held, 60);
  assert.equal(cx.ancestorChain[1].held, 0);
  assert.match(cx.stateHash, /^[0-9a-f]{64}$/);
  t.diagnostic(`counterexample stateHash=${cx.stateHash}`);
});

test('CLI rejects invalid input files with exit code 2', () => {
  const missing = runCli('no-such-tree.json', 'no-such-actors.json');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /INVALID_TREE/);
  const cyclic = path.join(__dirname, 'fixtures-cyclic-tree.json');
  fs.writeFileSync(
    cyclic,
    JSON.stringify({
      nodes: [
        { id: 'x', parent: 'y', capacity: 1 },
        { id: 'y', parent: 'x', capacity: 1 },
      ],
    }),
  );
  try {
    const res = runCli(cyclic, path.join(EXAMPLES, 'actors.json'));
    assert.equal(res.status, 2);
    assert.match(res.stderr, /INVALID_TREE/);
  } finally {
    fs.unlinkSync(cyclic);
  }
});
