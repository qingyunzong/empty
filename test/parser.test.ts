import { test } from 'node:test';
import { equal, match, throws } from 'node:assert/strict';
import { parseProgram, ParseError } from '../src/parser';

test('parses a valid program with all instruction kinds', () => {
  const p = parseProgram(`
var x = 0
mutex m
thread A
  lock m
  read r x
  write x r
  write x 42
  unlock m
  assert r == 0
  assert r != 1
  assert r <= 5
end
`);
  equal(p.threads.length, 1);
  equal(p.threads[0].instrs.length, 8);
  equal(p.vars.x, 0);
  equal(p.mutexes.length, 1);
});

test('accepts exactly 3 threads with 8 instructions each', () => {
  const body = Array.from({ length: 8 }, (_, i) => `  write x ${i}`).join('\n');
  const p = parseProgram(`var x = 0\nthread A\n${body}\nend\nthread B\n${body}\nend\nthread C\n${body}\nend\n`);
  equal(p.threads.length, 3);
  equal(p.threads[2].instrs.length, 8);
});

test('rejects a 4th thread', () => {
  const t = (n: string) => `thread ${n}\n  write x 1\nend`;
  throws(
    () => parseProgram(`var x = 0\n${t('A')}\n${t('B')}\n${t('C')}\n${t('D')}\n`),
    (e: Error) => e instanceof ParseError && /at most 3/.test(e.message),
  );
});

test('rejects a 9th instruction in a thread', () => {
  const body = Array.from({ length: 9 }, (_, i) => `  write x ${i}`).join('\n');
  throws(
    () => parseProgram(`var x = 0\nthread A\n${body}\nend\n`),
    (e: Error) => e instanceof ParseError && /more than 8/.test(e.message),
  );
});

test('rejects unknown variable, mutex, and register misuse', () => {
  throws(() => parseProgram('var x = 0\nthread A\n  read r y\nend\n'), /unknown shared variable 'y'/);
  throws(() => parseProgram('var x = 0\nthread A\n  lock m\nend\n'), /unknown mutex 'm'/);
  throws(() => parseProgram('var x = 0\nthread A\n  write x r\nend\n'), /used before any read/);
  throws(() => parseProgram('var x = 0\nthread A\n  assert r == 1\nend\n'), /used before any read/);
});

test('rejects structural errors', () => {
  throws(() => parseProgram('var x = 0\nthread A\n  write x 1\n'), /missing 'end'/);
  throws(() => parseProgram('var x = 0\n'), /at least one thread/);
  throws(() => parseProgram('var x = 0\nthread A\n  foo bar\nend\n'), /unrecognized instruction/);
  throws(() => parseProgram('var x = 0\nthread A\n  assert 1 ~ 2\nend\n'), /unknown comparison/);
});

test('parse errors carry line numbers', () => {
  try {
    parseProgram('var x = 0\nthread A\n  read r y\nend\n');
    throw new Error('should have thrown');
  } catch (e) {
    match((e as Error).message, /^line 3:/);
  }
});
