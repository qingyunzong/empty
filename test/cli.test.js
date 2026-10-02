import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../bin/cli.js';

const RULES = `rule Register {
  op write(key: string, value: int) -> string;
  op read(key: string) -> int;
  commutes(a, b): a.op == op"write" and b.op == op"write";
}`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'causallint-'));
  const rules = join(dir, 'rules.dsl');
  writeFileSync(rules, RULES);
  return { dir, rules };
}

// Run the CLI in-process (the offline sandbox forbids spawning children),
// capturing output and the returned exit code.
const run = (args) => {
  const out = [];
  const err = [];
  const status = main(args, { stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
};

test('cli: check LINEARIZABLE exits 0 and writes JSON report', () => {
  const { dir, rules } = fixture();
  const history = join(dir, 'h.jsonl');
  const out = join(dir, 'out.json');
  writeFileSync(history, '{"invocation":"e1","response":"r1","realTime":[0,1],"op":"write","key":"x","value":1}\n');
  const r = run(['check', rules, history, '--json', out]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /LINEARIZABLE/);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(report.verdict, 'LINEARIZABLE');
  assert.equal(report.versions[0].status, 'CURRENT');
});

test('cli: check NON_LINEARIZABLE exits 1', () => {
  const { dir, rules } = fixture();
  const history = join(dir, 'h.jsonl');
  writeFileSync(history, [
    '{"invocation":"e1","response":"r1","prev":"e2","realTime":[0,1],"op":"write","key":"x","value":1}',
    '{"invocation":"e2","response":"r2","prev":"e1","realTime":[2,3],"op":"write","key":"x","value":2}',
  ].join('\n'));
  const r = run(['check', rules, history]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /NON_LINEARIZABLE/);
});

test('cli: check UNKNOWN exits 3', () => {
  const { dir, rules } = fixture();
  const history = join(dir, 'h.jsonl');
  writeFileSync(history, '{"invocation":"e1","realTime":[0],"op":"write","key":"x","value":1}\n');
  const r = run(['check', rules, history]);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /UNKNOWN/);
});

test('cli: malformed history exits 2 with a line number', () => {
  const { dir, rules } = fixture();
  const history = join(dir, 'h.jsonl');
  writeFileSync(history, '{"invocation":"e1","op":"write","key":"x"}\noops\n');
  const r = run(['check', rules, history]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /h\.jsonl:2: error: invalid JSON/);
});

test('cli: DSL type error exits 2 with line and column', () => {
  const { dir } = fixture();
  const rules = join(dir, 'bad.dsl');
  writeFileSync(rules, 'rule R {\n  commutes(a, b): a.time < "x";\n}\n');
  const history = join(dir, 'h.jsonl');
  writeFileSync(history, '{"invocation":"e1","response":"r1","realTime":[0,1],"op":"write","key":"x","value":1}\n');
  const r = run(['check', rules, history]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bad\.dsl:2:26: error: operator < requires int/);
});

test('cli: usage error exits 2', () => {
  const r = run(['check']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});

test('cli: verify accepts a valid report and rejects a tampered one', () => {
  const { dir, rules } = fixture();
  const history = join(dir, 'h.jsonl');
  const out = join(dir, 'out.json');
  writeFileSync(history, '{"invocation":"e1","response":"r1","realTime":[0,1],"op":"write","key":"x","value":1}\n');
  assert.equal(run(['check', rules, history, '--json', out]).status, 0);

  const ok = run(['verify', out]);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /OK \(LINEARIZABLE\)/);

  const tampered = join(dir, 'tampered.json');
  const report = JSON.parse(readFileSync(out, 'utf8'));
  report.verdict = 'UNKNOWN';
  writeFileSync(tampered, JSON.stringify(report));
  const bad = run(['verify', tampered]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /INVALID/);

  const garbage = join(dir, 'garbage.json');
  writeFileSync(garbage, 'not json');
  assert.equal(run(['verify', garbage]).status, 2);
});
