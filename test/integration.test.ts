import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational } from "../src/rational";
import { TempoMap } from "../src/tempo-map";
import { compareWithIntegration, integrateMsDirect } from "../src/integration";
import { defaultSampleBeats } from "../src/certificate";

test("exact rational ms matches direct numerical integration", () => {
  const map = TempoMap.fromBpm(Rational.of(120));
  map.setTempo(Rational.of(2), Rational.of(60000).div(Rational.of(90)));
  map.setTempo(Rational.of(7, 2), Rational.of(60000).div(Rational.of(150)));

  const rows = compareWithIntegration(map, defaultSampleBeats(map), 400_000);
  for (const row of rows) {
    assert.ok(
      row.relError < 1e-6,
      `beat ${row.beat}: relErr ${row.relError} (exact ${row.exactMs}, integrated ${row.integratedMs})`,
    );
  }
});

test("direct integration converges to the exact value as slices grow", () => {
  const map = TempoMap.fromBpm(Rational.of(120));
  // boundary at 1/3 never aligns with a uniform slice grid, so the
  // midpoint-rule error must shrink monotonically as slices grow
  map.setTempo(Rational.of(1, 3), Rational.of(60000).div(Rational.of(90)));
  const target = Rational.of(5);
  const exact = map.beatToMs(target).toNumber();

  const coarse = Math.abs(integrateMsDirect(map, Rational.zero(), target, 1_000) - exact);
  const fine = Math.abs(integrateMsDirect(map, Rational.zero(), target, 400_000) - exact);
  assert.ok(fine < coarse, `expected ${fine} < ${coarse}`);
  assert.ok(fine < 1e-3);
});
