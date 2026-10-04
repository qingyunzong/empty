# layer-compositor

A versioned 2D layer library in TypeScript, built only on Node.js built-in
modules (no runtime dependencies).

## Model

- **Premultiplied RGBA on an integer grid.** Every channel is an integer
  numerator over a shared integer denominator `den` (default 255, arbitrary
  values supported). Invariants enforced at every write
  (`src/pixel.ts`): `0 <= r,g,b <= a <= den`, and **alpha 0 forces
  r=g=b=0 — transparent pixels never carry residual colour**.
- **Blending formula (source-over), rounded half-even at every layer.**
  For source `s` over destination `d` (`src/blend.ts`):

  ```
  inv   = den - s.a
  out.a = s.a + round_half_even(d.a * inv / den)
  out.c = s.c + round_half_even(d.c * inv / den)   for c in {r, g, b}
  ```

  `round_half_even` (`src/rounding.ts`) rounds exact ties to the even
  neighbour, and it is applied once per layer boundary as the stack is
  folded bottom-to-top — not once at the end.
- **Immutable layers, versioned document.** `Layer.withRect` returns a new
  layer; `LayerDocument.updateRect` commits a new version
  (`src/document.ts`). Any earlier `snapshot(v)` stays fully readable and
  re-renderable.
- **Dirty-rect compositing.** `Compositor.render` (`src/compositor.ts`)
  recomputes only the union of rectangles changed since the last rendered
  version and carries all other output pixels over untouched; structural
  changes (layer add) fall back to a full recompute. `pixelsRecomputed`
  exposes how much work was actually done.
- **Independent exact checker.** `src/exact.ts` re-implements the same
  formula with BigInt rational arithmetic and recomputes whole layers from
  scratch. The test suite cross-checks the fast Uint pipeline against it,
  verifies channel extrema stay within `[0, den]`, the premultiplied bound
  `c <= a`, zero residual colour in transparent pixels, and that
  incremental renders after overlapping rect updates match full recomputes.

## Layout

```
src/rounding.ts    round-half-even (number + BigInt)
src/pixel.ts       premultiplied pixel invariants
src/blend.ts       source-over blend, per-layer rounding
src/layer.ts       immutable layer grid, rect patching
src/document.ts    versioned layer stack, dirty-rect tracking
src/compositor.ts  incremental (dirty-rect) + full renderer
src/exact.ts       BigInt exact recompute + extrema (verification)
test/              node:test suites (21 tests)
```

## Usage

```ts
import { LayerDocument, Compositor } from "layer-compositor";

const doc = new LayerDocument(800, 600, 255);
const base = doc.addLayer([200, 100, 50, 255]); // opaque fill
doc.addLayer([10, 20, 30, 128]);                // translucent overlay

const compositor = new Compositor(800, 600, 255);
const v0 = compositor.render(doc);              // full render

doc.updateRect(base, { x: 10, y: 10, w: 50, h: 40 }, [255, 0, 0, 255]);
const v1 = compositor.render(doc);              // only the 50x40 rect recomputed

const oldOutput = compositor.fullRecompute(doc, 0); // version 0 still readable
```

## Test

Requires Node.js (built-in `node:test` runner) and a `tsc` compiler on
PATH (TypeScript >= 5; no `npm install` needed — zero dependencies).

```
npm test
```

### Recorded actual results

Environment: Node.js v22.22.1, tsc 7.0.2, Linux x86_64. Command: `npm test`
(= `tsc -p tsconfig.json && node --test dist/test/*.test.js`).

```
# Subtest: dist/test/blend.test.js      ok
# Subtest: dist/test/document.test.js   ok
# Subtest: dist/test/exact.test.js      ok
# Subtest: dist/test/pixel.test.js      ok
# Subtest: dist/test/rounding.test.js   ok
# tests 5
# pass 5
# fail 0
# duration_ms ~420
```

Individual tests (21/21 passing, `node dist/test/<file>` per file):

```
blend.test.js
  ok - source-over formula: worked examples on denominator 255
  ok - per-step rounding is half-even (ties exercised on even denominators)
  ok - rounding happens at every layer, not only at the end
  ok - fast pipeline matches exact BigInt arithmetic (randomised)
  ok - blending never produces residual colour in transparent output
document.test.js
  ok - rect update recomputes only the affected output region
  ok - old versions stay readable after updates
  ok - overlapping rect updates: incremental render equals full recompute
  ok - structural changes force a full recompute
  ok - re-rendering the same version recomputes nothing
  ok - incremental render matches exact BigInt composite after rect updates
exact.test.js
  ok - independent fraction recompute: extrema, premultiplied bounds, transparency
  ok - extrema of a single opaque layer reach the denominator
pixel.test.js
  ok - transparent pixels keep no residual colour
  ok - channels clamp into the premultiplied range [0, alpha]
  ok - non-integer numerators and bad denominators are rejected
  ok - TRANSPARENT constant is the zero pixel
rounding.test.js
  ok - round-half-even: exact quarters on denominator 4
  ok - round-half-even: halves and thirds
  ok - round-half-even: BigInt twin agrees on an exhaustive sweep
  ok - round-half-even: rejects invalid input
```
