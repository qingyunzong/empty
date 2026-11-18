import test from "node:test";
import assert from "node:assert/strict";

import {
  RenderEngine,
  deepMerge,
  mergePackageValues,
} from "../build/index.js";

function isRecord(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function define(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function clone(value) {
  if (Array.isArray(value)) return value.map((entry) => clone(entry));
  if (isRecord(value)) {
    const result = {};
    for (const key of Object.keys(value)) define(result, key, clone(value[key]));
    return result;
  }
  return value;
}

function referenceMergeRecords(base, override) {
  const result = {};
  for (const key of Object.keys(base)) define(result, key, clone(base[key]));
  for (const key of Object.keys(override)) {
    if (
      Object.hasOwn(result, key) &&
      isRecord(result[key]) &&
      isRecord(override[key])
    ) {
      define(result, key, referenceMergeRecords(result[key], override[key]));
    } else {
      define(result, key, clone(override[key]));
    }
  }
  return result;
}

function referenceMerge(layers) {
  let result;
  let initialized = false;
  for (const layer of layers) {
    if (layer === undefined) continue;
    if (!initialized) {
      result = clone(layer);
      initialized = true;
    } else if (isRecord(result) && isRecord(layer)) {
      result = referenceMergeRecords(result, layer);
    } else {
      result = clone(layer);
    }
  }
  return initialized ? result : {};
}

const factories = [
  { name: "missing", missing: true },
  { name: "null", make: () => null },
  { name: "zero", make: () => 0 },
  { name: "false", make: () => false },
  { name: "text", make: () => "x" },
  { name: "array", make: () => [1, { nested: true }] },
  { name: "record", make: () => ({ nested: 1 }) },
];

function enumerateTrees(paths, choices) {
  const trees = [];
  const slots = paths.length;
  const combinations = choices.length ** slots;

  for (let combination = 0; combination < combinations; combination += 1) {
    const tree = {};
    let current = combination;
    for (const path of paths) {
      const choice = choices[current % choices.length];
      current = Math.floor(current / choices.length);
      if (choice.missing) continue;

      let parent = tree;
      for (let index = 0; index < path.length - 1; index += 1) {
        if (!Object.hasOwn(parent, path[index])) define(parent, path[index], {});
        parent = parent[path[index]];
      }
      define(parent, path[path.length - 1], clone(choice.make()));
    }
    trees.push(tree);
  }

  return trees;
}

function readPath(tree, path) {
  let value = tree;
  for (const segment of path) {
    if (!isRecord(value) || !Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

function exhaustiveTriples(paths, choices, assertBytes = true) {
  const trees = enumerateTrees(paths, choices);
  let checked = 0;

  for (const base of trees) {
    for (const packageValues of trees) {
      for (const overrides of trees) {
        const actual = deepMerge(base, packageValues, overrides);
        const expected = referenceMerge([base, packageValues, overrides]);
        assert.deepStrictEqual(actual, expected);
        if (assertBytes) {
          assert.deepStrictEqual(
            Buffer.from(JSON.stringify(actual), "utf8"),
            Buffer.from(JSON.stringify(expected), "utf8"),
          );
        }
        checked += 1;
      }
    }
  }

  return checked;
}

test("exhaustively checks flat three-layer value trees", () => {
  const checked = exhaustiveTriples(
    [["a"], ["b"]],
    factories,
  );
  assert.equal(checked, factories.length ** 6);
});

test("exhaustively checks nested three-layer value trees", () => {
  const compact = [factories[0], factories[1], factories[5]];
  const checked = exhaustiveTriples(
    [["a", "x"], ["a", "y"], ["b"]],
    compact,
  );
  assert.equal(checked, compact.length ** 9);
});

test("exhaustive merged values render to reference UTF-8 bytes", () => {
  const compact = factories.slice(0, 5);
  const paths = [["a"], ["b"]];
  const trees = enumerateTrees(paths, compact);
  const template =
    "{{a}}|{{b}}|{{a}}";
  let checked = 0;

  for (const base of trees) {
    for (const packageValues of trees) {
      for (const overrides of trees) {
        const merged = mergePackageValues(base, packageValues, overrides);
        const reference = referenceMerge([base, packageValues, overrides]);
        const expected = `${renderReference(readPath(reference, ["a"]))}|${
          renderReference(readPath(reference, ["b"]))
        }|${renderReference(readPath(reference, ["a"]))}`;

        const engine = new RenderEngine({
          defaults: base,
          packageValues,
          overrides,
          templates: { view: template },
        });
        const snapshot = engine.snapshot();
        const batch = snapshot.renderAll();
        assert.deepStrictEqual(
          Buffer.from(snapshot.renderBytes("view")),
          Buffer.from(expected, "utf8"),
        );
        assert.deepStrictEqual(
          Buffer.from(batch.results.get("view").bytes),
          Buffer.from(expected, "utf8"),
        );
        assert.deepStrictEqual(merged, reference);
        checked += 1;
      }
    }
  }

  assert.equal(checked, compact.length ** 6);
});

function renderReference(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
