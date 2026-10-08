import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ParseError, parseProgram } from '../src/lang.js';
import { run } from '../src/cli.js';
import {
  canonicalOrder,
  exploreFull,
  explorePor,
  ExploreStats,
  TraceStep,
} from '../src/explore.js';

const RACE = `
shared x = 0
thread t0
  read r1
  write r1 + 1
  assert x == r1 + 1
thread t1
  read r1
  write r1 + 1
  assert x == r1 + 1
`;

const MUTEX = `
shared x = 0
thread t0
  lock
  read r1
  write r1 + 1
  assert x == r1 + 1
  unlock
thread t1
  lock
  read r1
  write r1 + 1
  assert x == r1 + 1
  unlock
`;

const READS = `
shared x = 7
thread t0
  read r1
  read r2
  read r3
thread t1
  read r1
  read r2
  read r3
thread t2
  read r1
  read r2
  read r3
`;

// ---------- input validation ----------

test('accepts the maximum program: 3 threads x 8 instructions', () => {
  const body = Array.from({ length: 8 }, () => '  read r1').join('\n');
  const src = `shared x = 0\nthread a\n${body}\nthread b\n${body}\nthread c\n${body}\n`;
  const p = parseProgram(src);
  assert.equal(p.threads.length, 3);
  assert.equal(p.threads[0].instrs.length, 8);
});

test('rejects more than 3 threads', () => {
  const src = `shared x = 0\nthread a\n  read r1\nthread b\n  read r1\nthread c\n  read r1\nthread d\n  read r1\n`;
  assert.throws(() => parseProgram(src), /too many threads: 4 \(max 3\)/);
});

test('rejects more than 8 instructions in a thread', () => {
  const body = Array.from({ length: 9 }, () => '  read r1').join('\n');
  assert.throws(() => parseProgram(`shared x = 0\nthread a\n${body}\n`), /9 instructions \(max 8\)/);
});

test('rejects unknown instructions with a line number', () => {
  assert.throws(
    () => parseProgram('shared x = 0\nthread a\n  read r1\n  jump 3\n'),
    (e) => e instanceof ParseError && /line 4: unknown instruction/.test(e.message),
  );
});

test('rejects instructions outside a thread and missing shared decl', () => {
  assert.throws(() => parseProgram('read r1\n'), /outside any thread/);
  assert.throws(() => parseProgram('thread a\n  read r1\n'), /missing "shared x/);
});

// ---------- exploration on small examples ----------

test('race: full enumeration finds shortest error history of 5 steps', () => {
  const full = exploreFull(parseProgram(RACE));
  assert.equal(full.executions, 20);
  assert.equal(full.errorCount, 4);
  assert.ok(full.shortest);
  assert.equal(full.shortest.steps.length, 5);
  assert.match(full.shortest.steps[4].text, /assert x == r1 \+ 1/);
  assert.match(full.shortest.error, /assertion failed \(2 == 1 is false\)/);
});

test('race: compressed exploration agrees on shortest length, explores less', () => {
  const prog = parseProgram(RACE);
  const full = exploreFull(prog);
  const por = explorePor(prog);
  assert.ok(por.shortest);
  assert.equal(por.shortest.steps.length, full.shortest!.steps.length);
  assert.equal(por.executions, 9); // vs 20 uncompressed
  assert.equal(por.errorCount, 3); // 4 failing executions collapse to 3 classes
  assert.ok(por.visited < full.visited);
});

test('mutex: locked increments never fail in either mode', () => {
  const prog = parseProgram(MUTEX);
  const full = exploreFull(prog);
  const por = explorePor(prog);
  assert.equal(full.errorCount, 0);
  assert.equal(por.errorCount, 0);
  assert.equal(full.shortest, null);
  assert.equal(por.shortest, null);
  assert.equal(full.executions, 2);
});

test('reads: 1680 interleavings compress to a single execution', () => {
  const prog = parseProgram(READS);
  const full = exploreFull(prog);
  const por = explorePor(prog);
  assert.equal(full.executions, 1680); // 9! / (3! 3! 3!)
  assert.equal(por.executions, 1);
  assert.equal(full.visited, 5248);
  assert.equal(por.visited, 64);
  assert.equal(por.errorCount, 0);
});

test('deadlock and unlock-without-lock are reported as errors', () => {
  const dead = exploreFull(parseProgram('shared x = 0\nthread a\n  lock\n  lock\n'));
  assert.equal(dead.errorCount, 1);
  assert.match(dead.shortest!.error, /deadlock/);
  assert.equal(dead.shortest!.steps.length, 1);

  const bad = exploreFull(parseProgram('shared x = 0\nthread a\n  unlock\n'));
  assert.equal(bad.errorCount, 1);
  assert.match(bad.shortest!.error, /unlock without holding the lock/);
});

// ---------- independence-swap compression ----------

function step(thread: number, pc: number, kind: 'read' | 'write'): TraceStep {
  const instr = kind === 'read' ? { kind: 'read' as const, reg: 1 } : { kind: 'write' as const, expr: { base: { kind: 'const' as const, value: 1 }, delta: 0 } };
  return { thread, pc, instr, text: '' };
}

test('canonicalOrder swaps adjacent independent steps, keeps dependent ones', () => {
  const indep = canonicalOrder([step(2, 0, 'read'), step(1, 0, 'read'), step(0, 0, 'read')]);
  assert.deepEqual(indep.map((s) => s.thread), [0, 1, 2]);

  const dep = canonicalOrder([step(1, 0, 'write'), step(0, 0, 'read')]);
  assert.deepEqual(dep.map((s) => s.thread), [1, 0]); // write does not commute
});

// ---------- compressed vs uncompressed cross-check ----------

test('compressed and uncompressed exploration agree on small programs', () => {
  const programs = [RACE, MUTEX, READS,
    'shared x = 0\nthread a\n  lock\n  lock\n',
    'shared x = 1\nthread a\n  write x + 1\n  assert x != 3\nthread b\n  write x + 1\nthread c\n  read r1\n  assert r1 <= 3\n',
  ];
  for (const src of programs) {
    const prog = parseProgram(src);
    const full: ExploreStats = exploreFull(prog);
    const por: ExploreStats = explorePor(prog);
    assert.equal(por.truncated, false);
    // same verdict
    assert.equal(por.errorCount > 0, full.errorCount > 0, src);
    // same shortest error history length
    assert.equal(por.shortest?.steps.length ?? null, full.shortest?.steps.length ?? null, src);
    // compression never explores more
    assert.ok(por.visited <= full.visited, src);
    assert.ok(por.executions <= full.executions, src);
  }
});

// ---------- CLI end to end (in-process: the sandbox forbids spawning) ----------

const EXAMPLES = new URL('../../examples/', import.meta.url).pathname;

function runCli(argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => { out.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { err.push(args.join(' ')); };
  try {
    return { code: run(argv), out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

test('cli: reports shortest error history and exit code 1', () => {
  const r = runCli([join(EXAMPLES, 'race.txt')]);
  assert.equal(r.code, 1);
  assert.match(r.out, /shortest error history has 5 step/);
  assert.match(r.out, /assertion failed \(2 == 1 is false\)/);
  assert.match(r.out, /por\s+visited=/);
});

test('cli: clean program exits 0', () => {
  const r = runCli([join(EXAMPLES, 'mutex.txt')]);
  assert.equal(r.code, 0);
  assert.match(r.out, /no assertion failure/);
});

test('cli: invalid input exits 2 with a validation message', () => {
  const f = join(tmpdir(), 'por-cli-bad.txt');
  writeFileSync(f, 'shared x = 0\nthread a\n  read r1\nthread b\n  read r1\nthread c\n  read r1\nthread d\n  read r1\n');
  const r = runCli([f]);
  assert.equal(r.code, 2);
  assert.match(r.err, /input error: too many threads: 4 \(max 3\)/);
});
