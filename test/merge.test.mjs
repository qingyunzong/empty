import test from "node:test";
import assert from "node:assert/strict";

import {
  cloneValue,
  deepMerge,
  mergeLayers,
  mergePackageValues,
} from "../build/index.js";

test("merges defaults, package values, and overrides by precedence", () => {
  const defaults = {
    service: {
      replicas: 1,
      labels: { tier: "web", managed: "default" },
      ports: [80, 443],
    },
    enabled: true,
  };
  const packageValues = {
    service: {
      replicas: 2,
      labels: { team: "core" },
      ports: [8080],
    },
    enabled: false,
  };
  const overrides = {
    service: {
      labels: { team: "edge" },
      ports: [],
    },
    enabled: null,
  };

  const merged = mergePackageValues(defaults, packageValues, overrides);

  assert.deepStrictEqual(merged, {
    service: {
      replicas: 2,
      labels: { tier: "web", managed: "default", team: "edge" },
      ports: [],
    },
    enabled: null,
  });
  assert.notStrictEqual(merged.service.ports, overrides.service.ports);
  assert.notStrictEqual(merged.service.labels, defaults.service.labels);
});

test("arrays replace instead of concatenating at every depth", () => {
  const overrides = { nested: { list: [{ id: 2 }, { id: 3 }] } };
  const merged = deepMerge(
    { list: [1, 2, 3], nested: { list: [{ id: 1 }] } },
    overrides,
  );

  assert.deepStrictEqual(merged, {
    list: [1, 2, 3],
    nested: { list: [{ id: 2 }, { id: 3 }] },
  });
  assert.notStrictEqual(merged.nested.list, overrides.nested.list);
  assert.notStrictEqual(merged.nested.list[0], overrides.nested.list[0]);
});

test("native Map layers merge by key and still replace arrays", () => {
  const base = new Map([
    ["service", { replicas: 1, ports: [80] }],
    ["clear", "value"],
  ]);
  const packageValues = new Map([
    ["service", { ports: [8080], team: "core" }],
    ["clear", null],
  ]);
  const overrides = new Map([
    ["service", { replicas: 3 }],
    ["enabled", true],
  ]);

  const merged = mergePackageValues(base, packageValues, overrides);

  assert.ok(merged instanceof Map);
  assert.deepStrictEqual(merged.get("service"), {
    replicas: 3,
    ports: [8080],
    team: "core",
  });
  assert.equal(merged.get("clear"), null);
  assert.equal(merged.get("enabled"), true);
  assert.notStrictEqual(merged.get("service"), packageValues.get("service"));
  assert.notStrictEqual(
    merged.get("service").ports,
    packageValues.get("service").ports,
  );
});

test("missing keys and explicit null or undefined are distinct", () => {
  const merged = deepMerge(
    { config: { keep: 1, clear: 2, undefine: 3 }, untouched: true },
    { config: { clear: null, undefine: undefined } },
  );

  assert.equal(merged.config.keep, 1);
  assert.equal(merged.config.clear, null);
  assert.equal(Object.hasOwn(merged.config, "clear"), true);
  assert.equal(merged.config.undefine, undefined);
  assert.equal(Object.hasOwn(merged.config, "undefine"), true);
  assert.equal(merged.untouched, true);

  const noChange = deepMerge({ config: { keep: 1 } }, { config: {} });
  assert.deepStrictEqual(noChange, { config: { keep: 1 } });
});

test("never shares mutable arrays or records with any input layer", () => {
  const base = { nested: { items: [{ value: 1 }] } };
  const override = { nested: { extra: { value: 2 } } };
  const merged = deepMerge(base, override);

  merged.nested.items[0].value = 99;
  merged.nested.extra.value = 100;
  base.nested.items[0].value = 7;
  override.nested.extra.value = 8;

  assert.equal(base.nested.items[0].value, 7);
  assert.equal(override.nested.extra.value, 8);
  assert.notStrictEqual(merged.nested.items, base.nested.items);
  assert.notStrictEqual(merged.nested.extra, override.nested.extra);
});

test("does not pollute Object.prototype through __proto__ or constructor", () => {
  const hostile = JSON.parse(
    '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"also":"no"}}}',
  );
  const merged = deepMerge({ safe: true }, hostile);

  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.prototype.also, undefined);
  assert.equal(Object.hasOwn(merged, "__proto__"), true);
  assert.equal(Object.hasOwn(merged, "constructor"), true);
  assert.equal(merged.safe, true);
});

test("clones common containers and supports empty layer lists", () => {
  const date = new Date("2026-01-02T03:04:05.000Z");
  const source = {
    date,
    map: new Map([["a", { value: 1 }]]),
    set: new Set([1, 2]),
    bytes: Uint8Array.from([1, 2, 3]),
  };
  const clone = cloneValue(source);

  assert.notStrictEqual(clone.date, source.date);
  assert.equal(clone.date.toISOString(), date.toISOString());
  assert.notStrictEqual(clone.map, source.map);
  assert.deepStrictEqual([...clone.map.entries()], [["a", { value: 1 }]]);
  assert.deepStrictEqual([...clone.set], [1, 2]);
  clone.bytes[0] = 9;
  assert.deepStrictEqual([...source.bytes], [1, 2, 3]);
  assert.deepStrictEqual(mergeLayers([]), {});
});
