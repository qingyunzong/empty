'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('../src/cli');
const { BudgetExceededError, QueryTypeError, RegexCompileError } = require('../src/errors');

const RECORDS = path.join(__dirname, '..', 'examples', 'records.json');
const SCHEMA = path.join(__dirname, '..', 'examples', 'schema.json');

// The sandboxed test environment cannot spawn child processes, so the
// CLI is driven in-process through main(); exit-code mapping is
// verified separately against the same error classes the CLI catches.
function runCli(argv) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => err.push(args.join(' '));
  let code;
  try {
    code = main(argv);
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { code, stdout: out.join('\n') + (out.length ? '\n' : ''), stderr: err.join('\n') };
}

// Mirrors the exit-code mapping in cli.js's __main__ block; returns
// { code, error } so tests can also inspect the failure message.
function exitCodeFor(fn) {
  try {
    return { code: fn(), error: null };
  } catch (err) {
    if (err instanceof BudgetExceededError) return { code: 1, error: err };
    if (err instanceof QueryTypeError || err instanceof RegexCompileError) {
      return { code: 2, error: err };
    }
    throw err;
  }
}

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evq-test-'));
}

test('run prints hits, instruction count and certificate', () => {
  const dir = makeDir();
  const state = path.join(dir, 'state.json');
  const res = runCli([
    'run', '--records', RECORDS, '--schema', SCHEMA,
    '--query', 'status:open and severity>=4', '--state', state,
  ]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^hits: EV-001 EV-004$/m);
  assert.match(res.stdout, /^instructions: \d+$/m);
  const cert = JSON.parse(res.stdout.slice(res.stdout.indexOf('certificate:') + 'certificate:'.length));
  assert.equal(cert.version, 1);
  assert.equal(cert.normalizedAst, '(and (cmp severity >= w"4") (match status w"open"))');
  assert.equal(typeof cert.schemaHash, 'string');
  assert.equal(cert.budget, 10000);
  assert.deepEqual(cert.hits, ['EV-001', 'EV-004']);
});

test('budget below required instructions: exit 1, no hits on stdout, state unchanged', () => {
  const dir = makeDir();
  const state = path.join(dir, 'state.json');
  const query = 'status:open or severity>=4';
  const base = ['run', '--records', RECORDS, '--schema', SCHEMA, '--state', state];

  const ok = runCli([...base, '--query', query]);
  assert.equal(ok.code, 0, ok.stderr);
  const needed = Number(ok.stdout.match(/^instructions: (\d+)$/m)[1]);
  const stateBefore = fs.readFileSync(state, 'utf8');

  const fail = exitCodeFor(() => main([...base, '--query', query, '--budget', String(needed - 1)]));
  assert.equal(fail.code, 1);
  assert.match(fail.error.message, /budget/i);
  assert.equal(fs.readFileSync(state, 'utf8'), stateBefore);
});

test('unknown field and string ordering comparison map to exit 2 with no state file', () => {
  const dir = makeDir();
  const state = path.join(dir, 'state.json');
  for (const query of ['owner:alice', 'title < "abc"']) {
    const { code } = exitCodeFor(() =>
      main(['run', '--records', RECORDS, '--schema', SCHEMA, '--query', query, '--state', state])
    );
    assert.equal(code, 2, query);
  }
  assert.equal(fs.existsSync(state), false);
});

test('invalid regex maps to exit 2', () => {
  const dir = makeDir();
  const { code, error } = exitCodeFor(() =>
    main(['run', '--records', RECORDS, '--schema', SCHEMA,
      '--query', 'title:/(unclosed/', '--state', path.join(dir, 'state.json')])
  );
  assert.equal(code, 2);
  assert.match(error.message, /regex/i);
});

test('undo and redo switch versions via the state file', () => {
  const dir = makeDir();
  const state = path.join(dir, 'state.json');
  const base = ['--records', RECORDS, '--schema', SCHEMA, '--state', state];
  assert.equal(runCli(['run', ...base, '--query', 'status:open']).code, 0);
  assert.equal(runCli(['run', ...base, '--query', 'status:closed']).code, 0);

  const undo = runCli(['undo', '--state', state]);
  assert.equal(undo.code, 0, undo.stderr);
  assert.match(undo.stdout, /^hits: EV-001 EV-003 EV-004 EV-006$/m);

  const redo = runCli(['redo', '--state', state]);
  assert.equal(redo.code, 0, redo.stderr);
  assert.match(redo.stdout, /^hits: EV-002 EV-005$/m);
});
