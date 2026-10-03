import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';

const EXAMPLES = fileURLToPath(new URL('../examples/', import.meta.url));

// The CLI is exercised in-process: the sandbox forbids spawning child
// processes, and main() accepts an injectable io object for exactly this.
function run(args) {
  const io = {
    out: '',
    err: '',
    stdout: { write(s) { io.out += s; } },
    stderr: { write(s) { io.err += s; } },
  };
  const status = main(args, io);
  return { status, stdout: io.out, stderr: io.err };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'linck-test-'));
}

test('check: linearizable history exits 0 and writes the certificate', () => {
  const dir = tmpdir();
  const out = path.join(dir, 'out.json');
  const r = run(['check', path.join(EXAMPLES, 'register.dsl'), path.join(EXAMPLES, 'linearizable.jsonl'), '--json', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /verdict: LINEARIZABLE/);
  const cert = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(cert.verdict, 'LINEARIZABLE');
  assert.equal(cert.versions.length, 1);
  assert.equal(cert.versions[0].status, 'CURRENT');
  assert.ok(Array.isArray(cert.versions[0].certificate.serialization));
});

test('check: causal cycle exits 1 with a sorted counterexample', () => {
  const dir = tmpdir();
  const out = path.join(dir, 'out.json');
  const r = run(['check', path.join(EXAMPLES, 'register.dsl'), path.join(EXAMPLES, 'cyclic.jsonl'), '--json', out]);
  assert.equal(r.status, 1, r.stderr);
  const cert = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(cert.verdict, 'NON_LINEARIZABLE');
  assert.deepEqual(cert.versions[0].certificate.counterexample, ['e1', 'e2']);
});

test('check: missing response exits 3 (UNKNOWN)', () => {
  const r = run(['check', path.join(EXAMPLES, 'register.dsl'), path.join(EXAMPLES, 'pending.jsonl')]);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stdout, /verdict: UNKNOWN/);
});

test('check: corrections supersede earlier verdicts', () => {
  const dir = tmpdir();
  const out = path.join(dir, 'out.json');
  const r = run(['check', path.join(EXAMPLES, 'register.dsl'), path.join(EXAMPLES, 'corrections.jsonl'), '--json', out]);
  assert.equal(r.status, 0, r.stderr);
  const cert = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(cert.versions[0].verdict, 'NON_LINEARIZABLE');
  assert.equal(cert.versions[0].status, 'SUPERSEDED');
  assert.equal(cert.versions[1].verdict, 'LINEARIZABLE');
  assert.equal(cert.versions[1].status, 'CURRENT');
});

test('check: DSL type error exits 2 with a line number', () => {
  const dir = tmpdir();
  const dsl = path.join(dir, 'bad.dsl');
  fs.writeFileSync(dsl, 'op w(key: string)\nrule r {\n  commutes w(k), w(k) when oops == 1\n}\n');
  const r = run(['check', dsl, path.join(EXAMPLES, 'linearizable.jsonl')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bad\.dsl: line 3: undefined variable "oops"/);
});

test('check: malformed history exits 2 with a line number', () => {
  const dir = tmpdir();
  const hist = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(hist, '{"id":"e1","node":"n1"}\n');
  const r = run(['check', path.join(EXAMPLES, 'register.dsl'), hist]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bad\.jsonl: line 1: missing required field/);
});

test('check: undeclared op in history exits 2 with a line number', () => {
  const dir = tmpdir();
  const hist = path.join(dir, 'h.jsonl');
  fs.writeFileSync(hist, '{"id":"e1","node":"n1","prev":null,"invocation":1,"response":2,"realTime":1,"op":"cas","key":"x","value":1}\n');
  const r = run(['check', path.join(EXAMPLES, 'register.dsl'), hist]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /h\.jsonl: line 1: undeclared op "cas"/);
});

test('verify: valid certificates exit 0', () => {
  const dir = tmpdir();
  for (const name of ['linearizable', 'cyclic', 'pending', 'corrections']) {
    const out = path.join(dir, `${name}.json`);
    const c = run(['check', path.join(EXAMPLES, 'register.dsl'), path.join(EXAMPLES, `${name}.jsonl`), '--json', out]);
    assert.notEqual(c.status, 2, c.stderr);
    const v = run(['verify', out]);
    assert.equal(v.status, 0, `${name}: ${v.stderr}`);
    assert.match(v.stdout, /certificate valid/);
  }
});

test('verify: tampered certificate exits 1', () => {
  const dir = tmpdir();
  const out = path.join(dir, 'out.json');
  run(['check', path.join(EXAMPLES, 'register.dsl'), path.join(EXAMPLES, 'cyclic.jsonl'), '--json', out]);
  const cert = JSON.parse(fs.readFileSync(out, 'utf8'));
  // Claim the non-linearizable history is linearizable with a bogus witness.
  cert.versions[0].verdict = 'LINEARIZABLE';
  cert.versions[0].certificate = { serialization: ['e1', 'e2'] };
  cert.verdict = 'LINEARIZABLE';
  fs.writeFileSync(out, JSON.stringify(cert));
  const v = run(['verify', out]);
  assert.equal(v.status, 1);
  assert.match(v.stderr, /invalid:/);
});

test('verify: malformed JSON exits 2', () => {
  const dir = tmpdir();
  const out = path.join(dir, 'out.json');
  fs.writeFileSync(out, '{not json');
  const r = run(['verify', out]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /invalid JSON/);
});

test('usage errors exit 2', () => {
  assert.equal(run([]).status, 2);
  assert.equal(run(['check']).status, 2);
  assert.equal(run(['check', 'a', 'b', '--bogus']).status, 2);
  assert.equal(run(['verify']).status, 2);
  assert.equal(run(['check', '/nonexistent.dsl', '/nonexistent.jsonl']).status, 2);
});
