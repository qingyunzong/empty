import * as assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalize, diffManifests, formatDiff } from "../src/manifest";
import { Manifest } from "../src/types";

const base: Manifest = {
  version: 1,
  entries: [
    { path: "keep.txt", type: "file", size: 4, sha256: "a" },
    { path: "gone.txt", type: "file", size: 1, sha256: "g" },
    { path: "mod.txt", type: "file", size: 1, sha256: "m1" },
    { path: "flip", type: "file", size: 1, sha256: "f" },
  ],
};

test("diff reports added, removed, changed and retyped entries", () => {
  const after: Manifest = {
    version: 1,
    entries: [
      { path: "keep.txt", type: "file", size: 4, sha256: "a" },
      { path: "mod.txt", type: "file", size: 2, sha256: "m2" },
      { path: "flip", type: "directory" },
      { path: "new.txt", type: "file", size: 3, sha256: "n" },
    ],
  };
  const diff = diffManifests(base, after);
  assert.equal(diff.equal, false);
  assert.deepEqual(diff.added.map((entry) => entry.path), ["new.txt"]);
  assert.deepEqual(diff.removed.map((entry) => entry.path), ["gone.txt"]);
  assert.deepEqual(diff.changed.map((change) => change.path), ["flip", "mod.txt"]);
  assert.deepEqual(diff.changed.find((change) => change.path === "flip")?.fields, ["type", "size", "sha256"]);
  assert.deepEqual(diff.changed.find((change) => change.path === "mod.txt")?.fields, ["size", "sha256"]);
  assert.match(formatDiff(diff), /~ mod\.txt \[size, sha256\]/);
});

test("identical manifests compare equal and canonicalize deterministically", () => {
  const diff = diffManifests(base, base);
  assert.equal(diff.equal, true);
  assert.equal(formatDiff(diff), "manifests are identical\n");
  const shuffled: Manifest = { version: 1, entries: [...base.entries].reverse() };
  assert.equal(canonicalize(shuffled), canonicalize(base));
});
