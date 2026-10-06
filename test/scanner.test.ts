import { test } from "node:test";
import assert from "node:assert/strict";
import { OUTSIDE, scanLine, type FenceState } from "../src/scanner.ts";

const inBacktick: FenceState = { open: true, char: "`", length: 3 };

test("ATX headings with levels and closing hashes", () => {
  assert.deepEqual(scanLine("# Title", OUTSIDE).headings, [{ level: 1, text: "Title" }]);
  assert.deepEqual(scanLine("###### Deep", OUTSIDE).headings, [{ level: 6, text: "Deep" }]);
  assert.deepEqual(scanLine("## Closed ##", OUTSIDE).headings, [{ level: 2, text: "Closed" }]);
  assert.deepEqual(scanLine("## hash#inside", OUTSIDE).headings, [
    { level: 2, text: "hash#inside" },
  ]);
});

test("non-headings", () => {
  assert.equal(scanLine("#nospace", OUTSIDE).headings.length, 0);
  assert.equal(scanLine("####### too many", OUTSIDE).headings.length, 0);
  assert.equal(scanLine("    # indented code", OUTSIDE).headings.length, 0);
  assert.equal(scanLine("   # three spaces ok", OUTSIDE).headings.length, 1);
});

test("fence open/close state machine", () => {
  const opened = scanLine("```js", OUTSIDE);
  assert.deepEqual(opened.stateAfter, { open: true, char: "`", length: 3 });

  const inside = scanLine("# not a heading", opened.stateAfter);
  assert.equal(inside.headings.length, 0);
  assert.deepEqual(inside.stateAfter, opened.stateAfter);

  const closed = scanLine("```", opened.stateAfter);
  assert.deepEqual(closed.stateAfter, OUTSIDE);
});

test("closing fence must match char and length, no info string", () => {
  // Tilde does not close a backtick fence.
  assert.deepEqual(scanLine("~~~", inBacktick).stateAfter, inBacktick);
  // Shorter run does not close.
  assert.deepEqual(
    scanLine("```", { open: true, char: "`", length: 4 }).stateAfter,
    { open: true, char: "`", length: 4 },
  );
  // Longer run closes.
  assert.deepEqual(scanLine("`````", inBacktick).stateAfter, OUTSIDE);
  // Info string on the closer means it is not a closer.
  assert.deepEqual(scanLine("``` js", inBacktick).stateAfter, inBacktick);
});

test("tilde fences and info strings", () => {
  const opened = scanLine("~~~~ text", OUTSIDE);
  assert.deepEqual(opened.stateAfter, { open: true, char: "~", length: 4 });
  // Backtick in info string of a backtick fence: not a fence at all.
  assert.deepEqual(scanLine("``` a ` b", OUTSIDE).stateAfter, OUTSIDE);
});

test("anchors and references outside fences", () => {
  const scan = scanLine('see <a name="target"></a> and [go](#target) [miss](#nope)', OUTSIDE);
  assert.deepEqual(scan.anchors, ["target"]);
  assert.deepEqual(scan.refs, [
    { text: "go", target: "target" },
    { text: "miss", target: "nope" },
  ]);
  const id = scanLine('<a id="by-id"></a>', OUTSIDE);
  assert.deepEqual(id.anchors, ["by-id"]);
});

test("anchors and references inside fences are ignored", () => {
  const scan = scanLine('<a name="x"></a> [y](#x)', inBacktick);
  assert.equal(scan.anchors.length, 0);
  assert.equal(scan.refs.length, 0);
});
