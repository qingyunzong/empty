import test from "node:test";
import assert from "node:assert/strict";
import {
  ConversionError,
  ResourceConverter,
  canonicalBytes,
  canonicalStringify,
  type ConversionTable,
  type ResourceObject,
} from "../index.ts";
import {
  ALPHA,
  BETA,
  COMPLETE_ALPHA,
  COMPLETE_BETA,
  COMPLETE_HUB,
  HUB,
  RETENTION_KEY,
  TABLE,
} from "./fixtures.ts";

function retentionOf(resource: ResourceObject): Record<string, unknown> | undefined {
  const metadata = resource.metadata;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const annotations = metadata.annotations;
  if (
    annotations === null ||
    typeof annotations !== "object" ||
    Array.isArray(annotations)
  ) {
    return undefined;
  }
  const raw = annotations[RETENTION_KEY];
  return typeof raw === "string"
    ? (JSON.parse(raw) as Record<string, unknown>)
    : undefined;
}

function bytes(resource: unknown): string {
  return Buffer.from(canonicalBytes(resource)).toString("hex");
}

function specOf(resource: ResourceObject): Record<string, unknown> {
  return resource.spec as Record<string, unknown>;
}

test("hub-spoke conversion renames fields and preserves explicit zero values", () => {
  const converter = new ResourceConverter(TABLE);
  const hub = converter.convert(COMPLETE_ALPHA, HUB);

  assert.equal(hub.apiVersion, HUB);
  assert.equal(hub.kind, "Widget");
  assert.deepEqual(specOf(hub), {
    debug: false,
    image: "",
    mode: "auto",
    replicas: 0,
  });

  const beta = converter.convert(COMPLETE_ALPHA, BETA);
  assert.deepEqual(specOf(beta), {
    imageName: "",
    replicas: 0,
  });
  assert.deepEqual(retentionOf(beta), {
    "spec.debug": false,
    "spec.mode": "auto",
  });
});

test("defaults are injected only for missing keys and only for the target version", () => {
  const converter = new ResourceConverter(TABLE);
  const minimalAlpha: ResourceObject = {
    apiVersion: ALPHA,
    kind: "Widget",
    metadata: { name: "minimal" },
    spec: {},
  };

  const hub = converter.convert(minimalAlpha, HUB);
  assert.deepEqual(specOf(hub), {
    image: "hub-default",
    replicas: 1,
  });

  const beta = converter.convert(minimalAlpha, BETA);
  assert.deepEqual(specOf(beta), { replicas: 2 });

  const explicitZero: ResourceObject = {
    apiVersion: ALPHA,
    kind: "Widget",
    metadata: { name: "explicit" },
    spec: { replicaCount: 0, image: "" },
  };
  assert.deepEqual(specOf(converter.convert(explicitZero, HUB)), {
    image: "",
    replicas: 0,
  });

  const explicitFalse: ResourceObject = {
    apiVersion: BETA,
    kind: "Widget",
    metadata: { name: "explicit-false" },
    spec: { replicas: 0, imageName: "", paused: false },
  };
  assert.deepEqual(specOf(converter.convert(explicitFalse, HUB)), {
    image: "",
    paused: false,
    replicas: 0,
  });

  const explicitNull: ResourceObject = {
    apiVersion: ALPHA,
    kind: "Widget",
    metadata: { name: "explicit-null" },
    spec: { replicaCount: null, image: null },
  };
  assert.deepEqual(specOf(converter.convert(explicitNull, HUB)), {
    image: null,
    replicas: null,
  });
});

test("default values are cloned for every conversion", () => {
  const converter = new ResourceConverter(TABLE);
  const minimal: ResourceObject = {
    apiVersion: ALPHA,
    kind: "Widget",
    metadata: { name: "clone" },
    spec: {},
  };
  const first = converter.convert(minimal, HUB);
  (first.spec as Record<string, unknown>).image = "mutated";
  const second = converter.convert(minimal, HUB);
  assert.equal((second.spec as Record<string, unknown>).image, "hub-default");
});

test("structured defaults are cloned and nested missing paths are created", () => {
  const table: ConversionTable = {
    hubVersion: "defaults.io/v1",
    versions: [
      {
        version: "defaults.io/v1",
        fields: ["spec.config", "spec.storage.size"],
        defaults: [
          {
            path: "spec.config",
            value: { enabled: true, tags: ["a", "b"] },
          },
          { path: "spec.storage.size", value: 0 },
        ],
      },
    ],
  };
  const converter = new ResourceConverter(table);
  const resource: ResourceObject = {
    apiVersion: "defaults.io/v1",
    kind: "Thing",
    metadata: { name: "defaults" },
    spec: {},
  };
  const first = converter.convert(resource, "defaults.io/v1");
  const second = converter.convert(resource, "defaults.io/v1");
  assert.deepEqual(specOf(first), {
    config: { enabled: true, tags: ["a", "b"] },
    storage: { size: 0 },
  });
  (specOf(first).config as Record<string, unknown>).tags = [];
  assert.deepEqual(specOf(second), {
    config: { enabled: true, tags: ["a", "b"] },
    storage: { size: 0 },
  });
});

test("complete resources round-trip byte for byte through every version", () => {
  const converter = new ResourceConverter(TABLE);
  const samples: ResourceObject[] = [
    COMPLETE_HUB,
    COMPLETE_ALPHA,
    COMPLETE_BETA,
  ];
  for (const source of samples) {
    for (const target of [HUB, ALPHA, BETA]) {
      const forward = converter.convert(source, target);
      const back = converter.convert(forward, String(source.apiVersion));
      assert.equal(
        bytes(back),
        bytes(source),
        `round-trip ${String(source.apiVersion)} -> ${target} -> ${String(source.apiVersion)} was not byte-identical\n${canonicalStringify(back)}`,
      );
    }
  }
});

test("downgrade stores exactly the unrepresentable values and re-upgrade restores them", () => {
  const converter = new ResourceConverter(TABLE);
  const beta = converter.convert(COMPLETE_HUB, BETA);

  assert.deepEqual(specOf(beta), {
    imageName: "registry.example/widget:1",
    paused: false,
    replicas: 3,
  });
  assert.deepEqual(retentionOf(beta), {
    "spec.debug": { enabled: true, tags: ["a", "b"] },
    "spec.mode": "manual",
    "spec.storage.class": "fast",
    "spec.storage.size": 10,
  });

  const hub = converter.convert(beta, HUB);
  assert.deepEqual(specOf(hub), specOf(COMPLETE_HUB));
  assert.equal(retentionOf(hub), undefined);
  assert.equal(bytes(hub), bytes(COMPLETE_HUB));
});

test("retention record is omitted when nothing is lost", () => {
  const converter = new ResourceConverter(TABLE);
  const hub: ResourceObject = {
    apiVersion: HUB,
    kind: "Widget",
    metadata: { name: "small" },
    spec: { replicas: 0 },
  };
  const beta = converter.convert(hub, BETA);
  assert.equal(retentionOf(beta), undefined);
  assert.deepEqual(beta.metadata, { name: "small" });
});

test("retained entries are rebuilt, so stale fields do not accumulate", () => {
  const converter = new ResourceConverter(TABLE);
  const firstHub: ResourceObject = {
    apiVersion: HUB,
    kind: "Widget",
    metadata: { name: "stale" },
    spec: { mode: "manual", debug: true },
  };
  const first = converter.convert(firstHub, BETA);
  assert.deepEqual(retentionOf(first), {
    "spec.debug": true,
    "spec.mode": "manual",
  });

  const secondHub: ResourceObject = {
    apiVersion: HUB,
    kind: "Widget",
    metadata: { name: "stale" },
    spec: { mode: "manual" },
  };
  const second = converter.convert(secondHub, BETA);
  assert.deepEqual(retentionOf(second), { "spec.mode": "manual" });
});

test("explicit spoke values win over stale retained entries and are consumed once", () => {
  const converter = new ResourceConverter(TABLE);
  const beta: ResourceObject = {
    apiVersion: BETA,
    kind: "Widget",
    metadata: {
      name: "conflict",
      annotations: {
        [RETENTION_KEY]: canonicalStringify({
          "spec.replicas": 99,
          "spec.mode": "restored",
        }),
      },
    },
    spec: { replicas: 5, imageName: "img" },
  };
  const hub = converter.convert(beta, HUB);
  assert.deepEqual(specOf(hub), {
    image: "img",
    mode: "restored",
    replicas: 5,
  });
  assert.deepEqual(hub.metadata, { name: "conflict" });
});

test("false, zero, empty string, null and structured values survive retention", () => {
  const converter = new ResourceConverter(TABLE);
  const hub: ResourceObject = {
    apiVersion: HUB,
    kind: "Widget",
    metadata: { name: "falsy" },
    spec: {
      replicas: 0,
      image: "",
      mode: null,
      paused: false,
      debug: { list: [0, false, "", null] },
      storage: { size: 0, class: "" },
    },
  };
  const beta = converter.convert(hub, BETA);
  assert.deepEqual(retentionOf(beta), {
    "spec.debug": { list: [0, false, "", null] },
    "spec.mode": null,
    "spec.storage.class": "",
    "spec.storage.size": 0,
  });
  assert.equal(bytes(converter.convert(beta, HUB)), bytes(hub));
});

test("metadata outside the retention annotation is preserved", () => {
  const converter = new ResourceConverter(TABLE);
  const hub = converter.convert(COMPLETE_HUB, BETA);
  const metadata = hub.metadata as Record<string, unknown>;
  assert.equal(metadata.name, "widget");
  assert.deepEqual(metadata.labels, { app: "demo", tier: "backend" });
  const annotations = metadata.annotations as Record<string, unknown>;
  assert.equal(annotations.team, "core");
  assert.equal(annotations["example.com/note"], "");
  assert.equal(typeof annotations[RETENTION_KEY], "string");

  const restored = converter.convert(hub, HUB);
  assert.equal(bytes(restored), bytes(COMPLETE_HUB));
});

test("invalid retention records fail loudly", () => {
  const converter = new ResourceConverter(TABLE);
  const invalid: ResourceObject = {
    apiVersion: BETA,
    kind: "Widget",
    metadata: {
      name: "bad",
      annotations: { [RETENTION_KEY]: "not-json" },
    },
    spec: {},
  };
  assert.throws(
    () => converter.convert(invalid, HUB),
    (error: unknown) =>
      error instanceof ConversionError && error.code === "invalid_retention",
  );

  const undeclared: ResourceObject = {
    apiVersion: BETA,
    kind: "Widget",
    metadata: {
      name: "bad-field",
      annotations: {
        [RETENTION_KEY]: canonicalStringify({ "spec.notInHub": 1 }),
      },
    },
    spec: {},
  };
  assert.throws(
    () => converter.convert(undeclared, HUB),
    (error: unknown) =>
      error instanceof ConversionError && error.code === "invalid_retention",
  );
});

test("unknown versions and malformed tables are rejected", () => {
  const converter = new ResourceConverter(TABLE);
  const unknown: ResourceObject = {
    apiVersion: "example.io/v9",
    kind: "Widget",
    metadata: {},
    spec: {},
  };
  assert.throws(
    () => converter.convert(unknown, HUB),
    (error: unknown) =>
      error instanceof ConversionError && error.code === "unknown_version",
  );
  assert.throws(
    () => converter.convert(COMPLETE_HUB, "example.io/v9"),
    (error: unknown) =>
      error instanceof ConversionError && error.code === "unknown_version",
  );

  assert.throws(
    () =>
      new ResourceConverter({
        hubVersion: HUB,
        versions: [
          { version: HUB, fields: ["spec.a"] },
          {
            version: ALPHA,
            fields: ["spec.a", "spec.b"],
            toHub: [
              { from: "spec.a", to: "spec.a" },
              { from: "spec.b", to: "spec.a" },
            ],
          },
        ],
      }),
    (error: unknown) =>
      error instanceof ConversionError && error.code === "invalid_mapping",
  );
});
