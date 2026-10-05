import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EditConflictError,
  applyEdits,
  expandResponseFile,
  parseCommand,
  renderCommand,
} from '../src/index.js';

test('per-byte provenance: every display byte maps to its source byte', () => {
  const files = new Map([
    ['/main.rsp', "alpha 'it''s\nhere' @inc.rsp\n"],
    ['/inc.rsp', '"quoted arg"\n'],
  ]);
  const rendered = renderCommand(expandResponseFile(files, '/main.rsp'));
  assert.equal(rendered.byteMap.length, rendered.display.length);

  // Reconstruct each argument's value purely from source bytes via byteMap.
  const parsed = parseCommand(rendered.display);
  assert.equal(parsed.length, rendered.args.length);
  rendered.args.forEach((arg, argIdx) => {
    assert.equal(arg.value, parsed[argIdx]);
    for (let i = 0; i < arg.value.length; i++) {
      const src = rendered.files.get(arg.span.file)!;
      assert.equal(src[arg.charMap[i]!], arg.value[i]);
    }
  });
  // Spot-check: separator spaces and added quotes have no source.
  const firstSpace = rendered.display.indexOf(' ');
  assert.equal(rendered.byteMap[firstSpace], null);
  // A literal byte in the display maps to the exact source offset.
  const aOffset = rendered.display.indexOf('alpha');
  const src0 = rendered.byteMap[aOffset]!;
  assert.equal(src0.file, '/main.rsp');
  assert.equal(files.get('/main.rsp')![src0.offset], 'a');
  // Newline inside the quoted token maps back into main.rsp.
  const nl = rendered.display.indexOf('\n');
  const nlSrc = rendered.byteMap[nl]!;
  assert.equal(files.get(nlSrc.file)![nlSrc.offset], '\n');
});

test('reverse edit: one argument rewritten in its source file', () => {
  const files = new Map([
    ['/main.rsp', "alpha 'two words' gamma\n"],
  ]);
  const rendered = renderCommand(expandResponseFile(files, '/main.rsp'));
  const updated = applyEdits(rendered, [{ argIndex: 1, newValue: "it's done\nnow" }]);
  assert.equal(updated.size, 1);
  const newMain = updated.get('/main.rsp')!;
  assert.equal(newMain, `alpha 'it'\\''s done\nnow' gamma\n`);
  // Re-expanding the edited graph yields the new value, same arg count.
  const again = expandResponseFile(new Map([['/main.rsp', newMain]]), '/main.rsp');
  assert.deepEqual(again.args.map((a) => a.value), ['alpha', "it's done\nnow", 'gamma']);
});

test('reverse edit: values that look like directives/includes are quoted', () => {
  const files = new Map([['/main.rsp', 'plain\n']]);
  const rendered = renderCommand(expandResponseFile(files, '/main.rsp'));
  for (const tricky of ['@other.rsp', '%if X', '#comment', '']) {
    const updated = applyEdits(rendered, [{ argIndex: 0, newValue: tricky }]);
    const again = expandResponseFile(new Map([['/main.rsp', updated.get('/main.rsp')!]]), '/main.rsp');
    assert.deepEqual(again.args.map((a) => a.value), [tricky], JSON.stringify(tricky));
  }
});

test('shared source referenced twice: single edit updates all references', () => {
  const files = new Map([
    ['/main.rsp', '@common.rsp\nmid\n@common.rsp\n'],
    ['/common.rsp', 'shared\n'],
  ]);
  const rendered = renderCommand(expandResponseFile(files, '/main.rsp'));
  assert.deepEqual(rendered.args.map((a) => a.value), ['shared', 'mid', 'shared']);
  // Edit only the FIRST occurrence; the source is shared, so both update.
  const updated = applyEdits(rendered, [{ argIndex: 0, newValue: 'changed' }]);
  const merged = new Map(files);
  for (const [k, v] of updated) merged.set(k, v);
  const again = expandResponseFile(merged, '/main.rsp');
  assert.deepEqual(again.args.map((a) => a.value), ['changed', 'mid', 'changed']);
});

test('conflicting edits to a shared source are fully rejected', () => {
  const files = new Map([
    ['/main.rsp', '@common.rsp\nmid\n@common.rsp\n'],
    ['/common.rsp', 'shared\n'],
  ]);
  const rendered = renderCommand(expandResponseFile(files, '/main.rsp'));
  assert.throws(
    () => applyEdits(rendered, [
      { argIndex: 0, newValue: 'one' },
      { argIndex: 1, newValue: 'middle' }, // fine on its own
      { argIndex: 2, newValue: 'two' },    // conflicts with argIndex 0
    ]),
    EditConflictError,
  );
  // Nothing was applied: the input snapshot is untouched.
  assert.equal(files.get('/common.rsp'), 'shared\n');
  assert.equal(files.get('/main.rsp'), '@common.rsp\nmid\n@common.rsp\n');
  // Same value on both occurrences of the shared span is accepted.
  const ok = applyEdits(rendered, [
    { argIndex: 0, newValue: 'same' },
    { argIndex: 2, newValue: 'same' },
  ]);
  assert.equal(ok.get('/common.rsp'), 'same\n');
});

test('batch edits across multiple files apply together', () => {
  const files = new Map([
    ['/main.rsp', 'a @inc.rsp z\n'],
    ['/inc.rsp', 'b\n'],
  ]);
  const rendered = renderCommand(expandResponseFile(files, '/main.rsp'));
  const updated = applyEdits(rendered, [
    { argIndex: 0, newValue: 'A' },
    { argIndex: 1, newValue: 'B B' },
    { argIndex: 2, newValue: 'Z' },
  ]);
  assert.equal(updated.get('/main.rsp'), 'A @inc.rsp Z\n');
  assert.equal(updated.get('/inc.rsp'), "'B B'\n");
});
