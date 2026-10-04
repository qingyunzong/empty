import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, print, evaluate, optimize, generate, mulberry32 } from '../src/index.js';

const SEEDS = 2000;

test('random small trees: value, first error and action log are preserved', () => {
  let errors = 0;
  let shared = 0;
  for (let seed = 0; seed < SEEDS; seed++) {
    const ast = generate(mulberry32(seed), 4);
    const src = print(ast);
    const parsed = parse(src);
    const before = evaluate(parsed);
    const { expr, rewrites } = optimize(parsed);
    const after = evaluate(expr);

    assert.deepEqual(
      { value: after.value, error: after.error?.message ?? null, log: after.log },
      { value: before.value, error: before.error?.message ?? null, log: before.log },
      `seed ${seed}: ${src}`,
    );

    // The first error must come from the same source fragment.
    if (before.error && after.error) {
      errors++;
      assert.equal(
        src.slice(after.error.span.start, after.error.span.end),
        src.slice(before.error.span.start, before.error.span.end),
        `seed ${seed}: ${src}`,
      );
    }

    // Every rewrite maps back into the original source.
    for (const rw of rewrites) {
      assert.ok(rw.before.start >= 0 && rw.before.end <= src.length, `seed ${seed}`);
      assert.ok(rw.after.start >= 0 && rw.after.end <= src.length, `seed ${seed}`);
      if (rw.rule === 'cse') shared++;
    }
  }
  assert.ok(errors > 0, 'expected some random programs to raise integer errors');
  assert.ok(shared > 0, 'expected some random programs to trigger CSE');
  console.log(`  ${SEEDS} random programs: ${errors} raised integer errors, ${shared} cse rewrites`);
});
