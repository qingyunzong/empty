import test from "node:test";
import assert from "node:assert/strict";
import {
  ResourceConverter,
  canonicalStringify,
  cloneJson,
  type JsonValue,
  type ResourceObject,
} from "../index.ts";
import {
  SMALL_ALPHA,
  SMALL_BETA,
  SMALL_FIELDS,
  SMALL_HUB,
  SMALL_RETENTION_KEY,
  SMALL_TABLE,
  naiveConvertSmall,
  naiveSmallToHub,
} from "./fixtures.ts";

const MISSING = Symbol("missing");

const VALUES: readonly unknown[] = [
  0,
  1,
  false,
  true,
  "",
  "text",
  null,
  { nested: 0 },
  [0, 1],
];

const VERSIONS = [SMALL_HUB, SMALL_ALPHA, SMALL_BETA];

function put(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const segments = path.split(".");
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (
      next === null ||
      typeof next !== "object" ||
      Array.isArray(next)
    ) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]!] = value;
}

function* choices(
  count: number,
  offset = 0,
  current: unknown[] = [],
): Generator<unknown[]> {
  if (offset === count) {
    yield current;
    return;
  }
  for (const value of [MISSING, ...VALUES]) {
    yield* choices(count, offset + 1, [...current, value]);
  }
}

test("exhaustive small field space matches the naive field-by-field mapping", () => {
  const converter = new ResourceConverter(SMALL_TABLE);
  let checked = 0;

  for (const sourceVersion of VERSIONS) {
    const fields = SMALL_FIELDS[sourceVersion]!;
    for (const combination of choices(fields.length)) {
      const resource: Record<string, unknown> = {
        apiVersion: sourceVersion,
        kind: "Thing",
        metadata: { name: "exhaustive" },
        spec: {},
      };
      for (let index = 0; index < fields.length; index += 1) {
        const value = combination[index];
        if (value !== MISSING) {
          put(resource, fields[index]!, cloneJson(value));
        }
      }
      const typed = resource as ResourceObject;

      for (const targetVersion of VERSIONS) {
        const actual = converter.convert(typed, targetVersion);
        const expected = naiveConvertSmall(typed, targetVersion);
        assert.equal(
          canonicalStringify(actual),
          canonicalStringify(expected),
          `mismatch for ${sourceVersion} -> ${targetVersion}\ninput: ${canonicalStringify(typed)}`,
        );
        checked += 1;
      }
    }
  }

  assert.equal(
    checked,
    ((VALUES.length + 1) ** 3 * 2 + (VALUES.length + 1) ** 4) * 3,
  );
});

const LOSSY_BY_TARGET: Readonly<Record<string, readonly string[]>> = {
  [SMALL_HUB]: [],
  [SMALL_ALPHA]: ["spec.c"],
  [SMALL_BETA]: ["spec.a"],
};

test("exhaustive retention is complete, duplicate-free, and restored exactly", () => {
  const converter = new ResourceConverter(SMALL_TABLE);

  for (const sourceVersion of VERSIONS) {
    const fields = SMALL_FIELDS[sourceVersion]!;
    for (const combination of choices(fields.length)) {
      const resource: Record<string, unknown> = {
        apiVersion: sourceVersion,
        kind: "Thing",
        metadata: { name: "retention" },
        spec: {},
      };
      for (let index = 0; index < fields.length; index += 1) {
        const value = combination[index];
        if (value !== MISSING) {
          put(resource, fields[index]!, cloneJson(value));
        }
      }
      if (!("spec" in resource)) {
        continue;
      }
      const typed = resource as ResourceObject;
      const hub = naiveSmallToHub(typed);
      for (const targetVersion of VERSIONS) {
        const target = converter.convert(typed, targetVersion);
        const retained = readRetention(target);
        const expectedPaths = LOSSY_BY_TARGET[targetVersion]!.filter(
          (path) => getPath(hub, path) !== MISSING,
        );
        assert.deepEqual(
          Object.keys(retained).sort(),
          expectedPaths.slice().sort(),
          `retention keys for ${sourceVersion} -> ${targetVersion}\ninput: ${canonicalStringify(typed)}`,
        );
        for (const path of expectedPaths) {
          assert.deepEqual(
            cloneJson(retained[path]),
            cloneJson(getPath(hub, path)),
            `retained value ${path} for ${sourceVersion} -> ${targetVersion}\ninput: ${canonicalStringify(typed)}`,
          );
        }

        const back = converter.convert(target, SMALL_HUB);
        for (const path of expectedPaths) {
          assert.deepEqual(
            cloneJson(getPath(back, path)),
            cloneJson(getPath(hub, path)),
            `restored value ${path} for ${sourceVersion} -> ${targetVersion} -> hub\ninput: ${canonicalStringify(typed)}`,
          );
        }
      }
    }
  }
});

function readRetention(resource: ResourceObject): Record<string, JsonValue> {
  const metadata = resource.metadata;
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    return {};
  }
  const annotations = metadata.annotations;
  if (
    annotations === null ||
    typeof annotations !== "object" ||
    Array.isArray(annotations)
  ) {
    return {};
  }
  const raw = annotations[SMALL_RETENTION_KEY];
  if (typeof raw !== "string") {
    return {};
  }
  return JSON.parse(raw) as Record<string, JsonValue>;
}

function getPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return MISSING;
    }
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) {
      return MISSING;
    }
  }
  return current;
}
