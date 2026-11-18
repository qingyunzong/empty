import test from "node:test";
import assert from "node:assert/strict";
import {
  ConversionError,
  ResourceConverter,
  canonicalBytes,
  canonicalStringify,
  canonicalize,
  type ResourceObject,
} from "../index.ts";
import { ALPHA, BETA, HUB, RETENTION_KEY, TABLE } from "./fixtures.ts";

test("canonical JSON sorts object keys recursively and preserves arrays", () => {
  const left = {
    z: 1,
    a: { d: [3, 2, 1], c: null },
    m: false,
  };
  const right = {
    m: false,
    a: { c: null, d: [3, 2, 1] },
    z: 1,
  };
  assert.equal(
    canonicalStringify(left),
    '{"a":{"c":null,"d":[3,2,1]},"m":false,"z":1}',
  );
  assert.deepEqual(canonicalBytes(left), canonicalBytes(right));
});

test("conversion output does not depend on input property insertion order", () => {
  const converter = new ResourceConverter(TABLE);
  const first = JSON.parse(
    '{"kind":"Widget","spec":{"debug":false,"image":"","legacyMode":"auto","replicaCount":0},"metadata":{"annotations":{"b":"2","a":"1"},"name":"ordered","labels":{"z":"1","a":"2"}},"apiVersion":"example.io/v1alpha1"}',
  ) as ResourceObject;
  const second = JSON.parse(
    '{"apiVersion":"example.io/v1alpha1","metadata":{"labels":{"a":"2","z":"1"},"name":"ordered","annotations":{"a":"1","b":"2"}},"spec":{"replicaCount":0,"legacyMode":"auto","image":"","debug":false},"kind":"Widget"}',
  ) as ResourceObject;

  for (const target of [HUB, ALPHA, BETA]) {
    assert.equal(
      canonicalStringify(converter.convert(first, target)),
      canonicalStringify(converter.convert(second, target)),
    );
  }
});

test("canonicalization rejects values that JSON cannot represent deterministically", () => {
  assert.throws(
    () => canonicalize({ value: Number.NaN }),
    (error: unknown) =>
      error instanceof ConversionError &&
      error.code === "invalid_json_value",
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(
    () => canonicalize(cyclic),
    (error: unknown) =>
      error instanceof ConversionError &&
      error.code === "invalid_json_value",
  );
});

test("data keys that look like prototype names stay ordinary own properties", () => {
  const resource = JSON.parse(
    '{"apiVersion":"example.io/v1","kind":"Widget","metadata":{"name":"proto"},"spec":{"replicas":1,"debug":{"__proto__":{"polluted":true}}}}',
  ) as ResourceObject;
  const converter = new ResourceConverter(TABLE);
  const beta = converter.convert(resource, BETA);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const metadata = beta.metadata as Record<string, unknown>;
  const annotations = metadata.annotations as Record<string, string>;
  const retention = JSON.parse(annotations[RETENTION_KEY]!) as Record<
    string,
    unknown
  >;
  assert.equal(
    canonicalStringify(retention["spec.debug"]),
    '{"__proto__":{"polluted":true}}',
  );
});

test("structural keys cannot be declared as convertible fields", () => {
  assert.throws(
    () =>
      new ResourceConverter({
        hubVersion: HUB,
        versions: [{ version: HUB, fields: ["metadata.name"] }],
      }),
    (error: unknown) =>
      error instanceof ConversionError && error.code === "invalid_table",
  );
});
