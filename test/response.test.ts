import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommand,
  expandResponseFile,
  parseCommand,
  renderCommand,
} from '../src/index.js';

test('expansion across multiple files with conditional branches', () => {
  const files = new Map([
    ['/main.rsp', [
      '# entry point',
      'alpha',
      '@sub/extra.rsp',
      '%if MODE=fast',
      'fast-flag',
      '%else',
      'slow-flag',
      '%endif',
      '%if DEBUG',
      'debug-on',
      '%endif',
      'omega',
    ].join('\n')],
    ['/sub/extra.rsp', 'beta gamma\n%if MODE!=fast\nextra-slow\n%endif\n'],
  ]);
  const fast = expandResponseFile(files, '/main.rsp', { MODE: 'fast' });
  assert.deepEqual(fast.args.map((a) => a.value), ['alpha', 'beta', 'gamma', 'fast-flag', 'omega']);
  const slow = expandResponseFile(files, '/main.rsp', { MODE: 'slow', DEBUG: '1' });
  assert.deepEqual(
    slow.args.map((a) => a.value),
    ['alpha', 'beta', 'gamma', 'extra-slow', 'slow-flag', 'debug-on', 'omega'],
  );
});

test('cross-file quoting: quotes inside included files, quoted @ stays literal', () => {
  const files = new Map([
    ['/a.rsp', '@dir/b.rsp\n"@not-an-include"\n'],
    ['/dir/b.rsp', `'it'\\''s here' "double \\"q\\" and $VAR" plain\\ space\n'multi\nline'\n`],
  ]);
  const { args } = expandResponseFile(files, '/a.rsp');
  assert.deepEqual(
    args.map((a) => a.value),
    [`it's here`, 'double "q" and $VAR', 'plain space', 'multi\nline', '@not-an-include'],
  );
  // provenance: first arg lives in b.rsp, last one in a.rsp
  assert.equal(args[0]!.span.file, '/dir/b.rsp');
  assert.equal(args[4]!.span.file, '/a.rsp');
});

test('virtual file graph: diamond include duplicates args with identical spans', () => {
  const files = new Map([
    ['/main.rsp', '@left.rsp\n@right.rsp\n'],
    ['/left.rsp', '@common.rsp\nL\n'],
    ['/right.rsp', '@common.rsp\nR\n'],
    ['/common.rsp', 'shared-arg\n'],
  ]);
  const { args } = expandResponseFile(files, '/main.rsp');
  assert.deepEqual(args.map((a) => a.value), ['shared-arg', 'L', 'shared-arg', 'R']);
  assert.deepEqual(args[0]!.span, args[2]!.span);
  assert.equal(args[0]!.span.file, '/common.rsp');
});

test('virtual file graph: include cycles are rejected', () => {
  const files = new Map([
    ['/a.rsp', '@b.rsp\n'],
    ['/b.rsp', '@a.rsp\n'],
  ]);
  assert.throws(() => expandResponseFile(files, '/a.rsp'), /cycle/);
  const selfLoop = new Map([['/s.rsp', '@s.rsp\n']]);
  assert.throws(() => expandResponseFile(selfLoop, '/s.rsp'), /cycle/);
});

test('missing files and NUL bytes are rejected', () => {
  assert.throws(() => expandResponseFile(new Map(), '/nope.rsp'), /not found/);
  const nul = new Map([['/n.rsp', 'a\0b\n']]);
  assert.throws(() => expandResponseFile(nul, '/n.rsp'), /NUL/);
});

test('end-to-end: expand -> render -> parse round-trips values and count', () => {
  const files = new Map([
    ['/main.rsp', "plain 'has space' '' 'quo''te' @sub.rsp\n"],
    ['/sub.rsp', "'new\nline' tab\\there\n"],
  ]);
  const expansion = expandResponseFile(files, '/main.rsp');
  const rendered = renderCommand(expansion);
  const values = expansion.args.map((a) => a.value);
  assert.deepEqual(parseCommand(rendered.display), values);
  assert.equal(rendered.display, buildCommand(values));
});
