import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProgram } from '../src/parser';
import { exploreDpor } from '../src/dpor';
import { exploreFull } from '../src/full';
import { ExploreResult, interleavingCount, totalInstrs, TraceStep } from '../src/explore';
import { initialState, isDeadlock, step } from '../src/state';
import { Program } from '../src/model';

interface Expectation {
  verdict: 'SAFE' | 'UNSAFE';
  shortestError: number | null;
}

const EXAMPLES: Array<{ file: string; expected: Expectation }> = [
  { file: 'ex1-read-race.prog', expected: { verdict: 'UNSAFE', shortestError: 2 } },
  { file: 'ex2-message-passing.prog', expected: { verdict: 'SAFE', shortestError: null } },
  { file: 'ex3-mutex-race.prog', expected: { verdict: 'UNSAFE', shortestError: 4 } },
  { file: 'ex4-deadlock.prog', expected: { verdict: 'UNSAFE', shortestError: 2 } },
  { file: 'ex5-independent.prog', expected: { verdict: 'SAFE', shortestError: null } },
  { file: 'ex6-max-size.prog', expected: { verdict: 'SAFE', shortestError: null } },
  { file: 'ex7-three-thread-unsafe.prog', expected: { verdict: 'UNSAFE', shortestError: 4 } },
];

function load(file: string) {
  return parseProgram(readFileSync(`examples/${file}`, 'utf8'));
}

function shortestLen(r: ExploreResult): number | null {
  return r.shortestError === null ? null : r.shortestError.length;
}

/** Replay a trace; returns the violation message if a step fails, else null. */
function replayViolation(program: Program, trace: TraceStep[]): string | null {
  let s = initialState(program);
  for (const t of trace) {
    const r = step(program, s, t.tid);
    if (r.violation !== null) return r.violation.message;
    s = r.next;
  }
  return null;
}

/** Replay a trace; true when it ends in a deadlock state. */
function replayDeadlock(program: Program, trace: TraceStep[]): boolean {
  let s = initialState(program);
  for (const t of trace) s = step(program, s, t.tid).next;
  return isDeadlock(program, s);
}

for (const { file, expected } of EXAMPLES) {
  test(`${file}: reduced and full exploration agree`, () => {
    const program = load(file);
    const por = exploreDpor(program);
    const full = exploreFull(program);

    // Both explorations must terminate and agree on the verdict.
    equal(por.verdict, expected.verdict, 'POR verdict');
    equal(full.verdict, expected.verdict, 'full verdict');

    // The shortest error history must have the same length in both
    // (all interleavings in one swap-equivalence class have equal length).
    equal(shortestLen(por), expected.shortestError, 'POR shortest error length');
    equal(shortestLen(full), expected.shortestError, 'full shortest error length');

    // Compression bound: the reduced search explores at most one execution
    // per interleaving (usually far fewer: one per swap-equivalence class).
    const interleavings = interleavingCount(program);
    ok(BigInt(por.stats.executions!) <= interleavings,
      `POR executions ${por.stats.executions} <= interleavings ${interleavings}`);
    ok(BigInt(por.stats.transitions) <= BigInt(totalInstrs(program)) * interleavings,
      'POR transitions within stateless bound');

    // The reported shortest error history replays to an actual violation.
    if (por.shortestError !== null) {
      const finding = por.findings.find(f => f.trace === por.shortestError)!;
      if (finding.violation.kind === 'deadlock') {
        ok(replayDeadlock(program, por.shortestError), 'POR shortest error replays to a deadlock');
      } else {
        ok(replayViolation(program, por.shortestError) !== null, 'POR shortest error replays to a violation');
      }
    }

    console.log(
      `    ${file}: verdict=${por.verdict} shortest=${shortestLen(por) ?? '-'} ` +
      `por{trans=${por.stats.transitions}, execs=${por.stats.executions}} ` +
      `full{trans=${full.stats.transitions}, states=${full.stats.states}} ` +
      `interleavings=${interleavings}`,
    );
  });
}

test('swap reduction collapses fully independent threads to one class', () => {
  const program = load('ex5-independent.prog');
  const por = exploreDpor(program);
  equal(por.stats.executions, 1); // 9!/(3!3!3!) = 1680 interleavings, 1 class
  const full = exploreFull(program);
  ok(full.stats.transitions > por.stats.transitions);
});

test('shortest error history is a valid failing replay', () => {
  const program = load('ex1-read-race.prog');
  const por = exploreDpor(program);
  const trace = por.shortestError!;
  equal(trace.length, 2);
  equal(trace[0].instrText, 'read r x');
  equal(trace[1].instrText, 'assert r == 1');
  equal(trace[0].threadName, 'Checker');
});

test('deadlock is reported by both explorations', () => {
  const program = load('ex4-deadlock.prog');
  for (const r of [exploreDpor(program), exploreFull(program)]) {
    equal(r.verdict, 'UNSAFE');
    ok(r.findings.some(f => f.violation.kind === 'deadlock'));
  }
});

test('step budget truncation yields INCOMPLETE', () => {
  const program = load('ex6-max-size.prog');
  const por = exploreDpor(program, 5);
  equal(por.verdict, 'INCOMPLETE');
  equal(por.stats.truncated, true);
});
