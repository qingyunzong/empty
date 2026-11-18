import {
  DEFAULT_RETENTION_ANNOTATION,
  canonicalStringify,
  cloneJson,
  type ConversionTable,
  type JsonObject,
  type JsonValue,
  type ResourceObject,
} from "../index.ts";

export const RETENTION_KEY = DEFAULT_RETENTION_ANNOTATION;

export const HUB = "example.io/v1";
export const ALPHA = "example.io/v1alpha1";
export const BETA = "example.io/v1beta1";

export const TABLE: ConversionTable = {
  hubVersion: HUB,
  retention: { annotationKey: RETENTION_KEY },
  versions: [
    {
      version: HUB,
      fields: [
        "spec.replicas",
        "spec.image",
        "spec.mode",
        "spec.paused",
        "spec.debug",
        "spec.storage.size",
        "spec.storage.class",
      ],
      defaults: [
        { path: "spec.replicas", value: 1 },
        { path: "spec.image", value: "hub-default" },
      ],
    },
    {
      version: ALPHA,
      fields: [
        "spec.replicaCount",
        "spec.image",
        "spec.legacyMode",
        "spec.debug",
      ],
      toHub: [
        { from: "spec.replicaCount", to: "spec.replicas" },
        { from: "spec.legacyMode", to: "spec.mode" },
      ],
      defaults: [{ path: "spec.replicaCount", value: 3 }],
    },
    {
      version: BETA,
      fields: ["spec.replicas", "spec.imageName", "spec.paused"],
      toHub: [{ from: "spec.imageName", to: "spec.image" }],
      defaults: [{ path: "spec.replicas", value: 2 }],
    },
  ],
};

export const BASE_METADATA = {
  name: "widget",
  labels: { app: "demo", tier: "backend" },
  annotations: { team: "core", "example.com/note": "" },
} as const;

export const COMPLETE_HUB: ResourceObject = {
  apiVersion: HUB,
  kind: "Widget",
  metadata: cloneJson(BASE_METADATA) as JsonObject,
  spec: {
    replicas: 3,
    image: "registry.example/widget:1",
    mode: "manual",
    paused: false,
    debug: { enabled: true, tags: ["a", "b"] },
    storage: { size: 10, class: "fast" },
  },
};

export const COMPLETE_ALPHA: ResourceObject = {
  apiVersion: ALPHA,
  kind: "Widget",
  metadata: cloneJson(BASE_METADATA) as JsonObject,
  spec: {
    replicaCount: 0,
    image: "",
    legacyMode: "auto",
    debug: false,
  },
};

export const COMPLETE_BETA: ResourceObject = {
  apiVersion: BETA,
  kind: "Widget",
  metadata: cloneJson(BASE_METADATA) as JsonObject,
  spec: {
    replicas: 0,
    imageName: "",
    paused: false,
  },
};

export const HUB_FIELDS = [
  "spec.replicas",
  "spec.image",
  "spec.mode",
  "spec.paused",
  "spec.debug",
  "spec.storage.size",
  "spec.storage.class",
] as const;

const ALPHA_TO_HUB: Readonly<Record<string, string>> = {
  "spec.replicaCount": "spec.replicas",
  "spec.image": "spec.image",
  "spec.legacyMode": "spec.mode",
  "spec.debug": "spec.debug",
};

const BETA_TO_HUB: Readonly<Record<string, string>> = {
  "spec.replicas": "spec.replicas",
  "spec.imageName": "spec.image",
  "spec.paused": "spec.paused",
};

const DEFAULTS_BY_VERSION: Readonly<
  Record<string, Readonly<Record<string, JsonValue>>>
> = {
  [HUB]: {
    "spec.replicas": 1,
    "spec.image": "hub-default",
  },
  [ALPHA]: {
    "spec.replicaCount": 3,
  },
  [BETA]: {
    "spec.replicas": 2,
  },
};

const VERSION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  [HUB]: HUB_FIELDS,
  [ALPHA]: [
    "spec.replicaCount",
    "spec.image",
    "spec.legacyMode",
    "spec.debug",
  ],
  [BETA]: ["spec.replicas", "spec.imageName", "spec.paused"],
};

const VERSION_TO_HUB: Readonly<Record<string, Readonly<Record<string, string>>>> =
  {
    [HUB]: Object.fromEntries(HUB_FIELDS.map((field) => [field, field])),
    [ALPHA]: ALPHA_TO_HUB,
    [BETA]: BETA_TO_HUB,
  };

function own(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function get(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !own(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function has(source: unknown, path: string): boolean {
  return get(source, path) !== undefined;
}

function put(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    if (
      !own(current, segment) ||
      current[segment] === null ||
      typeof current[segment] !== "object" ||
      Array.isArray(current[segment])
    ) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]!] = value;
}

function remove(target: Record<string, unknown>, path: string): boolean {
  const segments = path.split(".");
  let current: Record<string, unknown> = target;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      return false;
    }
    current = next as Record<string, unknown>;
  }
  const last = segments[segments.length - 1]!;
  if (!own(current, last)) {
    return false;
  }
  delete current[last];
  return true;
}

function clone(value: unknown): JsonValue {
  return cloneJson(value);
}

function stripRetention(
  source: Record<string, unknown>,
  retentionKey = RETENTION_KEY,
): {
  metadata: Record<string, unknown> | undefined;
  retained: Record<string, JsonValue>;
} {
  if (!own(source, "metadata")) {
    return { metadata: undefined, retained: {} };
  }
  const metadata = clone(source.metadata) as Record<string, unknown>;
  const retained: Record<string, JsonValue> = {};
  if (!own(metadata, "annotations")) {
    return { metadata, retained };
  }
  const annotations = clone(metadata.annotations) as Record<string, unknown>;
  if (!own(annotations, retentionKey)) {
    return { metadata, retained };
  }
  const raw = annotations[retentionKey];
  if (typeof raw !== "string") {
    throw new Error("naive: retention annotation is not a string");
  }
  const parsed = JSON.parse(raw) as Record<string, JsonValue>;
  for (const path of Object.keys(parsed).sort()) {
    retained[path] = clone(parsed[path]);
  }
  delete annotations[retentionKey];
  if (Object.keys(annotations).length === 0) {
    delete metadata.annotations;
  } else {
    metadata.annotations = annotations;
  }
  return { metadata, retained };
}

function baseOutput(
  version: string,
  source: Record<string, unknown>,
  retentionKey = RETENTION_KEY,
): Record<string, unknown> {
  const { metadata } = stripRetention(source, retentionKey);
  const result: Record<string, unknown> = { apiVersion: version };
  if (own(source, "kind")) {
    result.kind = clone(source.kind);
  }
  if (metadata !== undefined) {
    result.metadata = metadata;
  }
  return result;
}

/**
 * Deliberately simple field-by-field implementation of the fixture. It does
 * not share mapping/compilation code with the converter under test.
 */
export function naiveToHub(source: ResourceObject): ResourceObject {
  const sourceVersion = String(source.apiVersion);
  const result = baseOutput(HUB, source);
  const map = VERSION_TO_HUB[sourceVersion];
  if (map === undefined) {
    throw new Error(`naive: unknown source version ${sourceVersion}`);
  }
  for (const [from, to] of Object.entries(map)) {
    if (has(source, from)) {
      put(result, to, clone(get(source, from)));
    }
  }
  const { retained } = stripRetention(source);
  for (const path of Object.keys(retained).sort()) {
    if (!has(result, path)) {
      put(result, path, clone(retained[path]));
    }
  }
  return result as ResourceObject;
}

export function naiveFromHub(
  hub: ResourceObject,
  targetVersion: string,
): ResourceObject {
  const result = baseOutput(targetVersion, hub);
  const targetMap = VERSION_TO_HUB[targetVersion];
  if (targetMap === undefined) {
    throw new Error(`naive: unknown target version ${targetVersion}`);
  }
  for (const [path, hubPath] of Object.entries(targetMap)) {
    if (has(hub, hubPath)) {
      put(result, path, clone(get(hub, hubPath)));
    }
  }

  const defaults = DEFAULTS_BY_VERSION[targetVersion] ?? {};
  for (const path of Object.keys(defaults).sort()) {
    if (!has(result, path)) {
      put(result, path, clone(defaults[path]));
    }
  }

  const representable = new Set(Object.values(targetMap));
  const retained: Record<string, JsonValue> = {};
  for (const hubField of HUB_FIELDS) {
    if (!representable.has(hubField) && has(hub, hubField)) {
      retained[hubField] = clone(get(hub, hubField));
    }
  }
  if (Object.keys(retained).length > 0) {
    const metadata =
      (result.metadata as Record<string, unknown> | undefined) ?? {};
    const annotations =
      (metadata.annotations as Record<string, unknown> | undefined) ?? {};
    annotations[RETENTION_KEY] = canonicalStringify(retained);
    metadata.annotations = annotations;
    result.metadata = metadata;
  }
  return result as ResourceObject;
}

export function naiveConvert(
  source: ResourceObject,
  targetVersion: string,
): ResourceObject {
  return naiveFromHub(naiveToHub(source), targetVersion);
}

export const SMALL_HUB = "small.io/v1";
export const SMALL_ALPHA = "small.io/v1alpha1";
export const SMALL_BETA = "small.io/v1beta1";
export const SMALL_RETENTION_KEY = "small.io/retained";

export const SMALL_TABLE: ConversionTable = {
  hubVersion: SMALL_HUB,
  retention: { annotationKey: SMALL_RETENTION_KEY },
  versions: [
    {
      version: SMALL_HUB,
      fields: ["spec.a", "spec.b", "spec.c", "spec.d"],
      defaults: [
        { path: "spec.a", value: 1 },
        { path: "spec.b", value: "hub-b" },
      ],
    },
    {
      version: SMALL_ALPHA,
      fields: ["spec.a", "spec.oldB", "spec.d"],
      toHub: [{ from: "spec.oldB", to: "spec.b" }],
      defaults: [{ path: "spec.oldB", value: 7 }],
    },
    {
      version: SMALL_BETA,
      fields: ["spec.b", "spec.c", "spec.newD"],
      toHub: [{ from: "spec.newD", to: "spec.d" }],
      defaults: [{ path: "spec.b", value: "beta-b" }],
    },
  ],
};

export const SMALL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  [SMALL_HUB]: ["spec.a", "spec.b", "spec.c", "spec.d"],
  [SMALL_ALPHA]: ["spec.a", "spec.oldB", "spec.d"],
  [SMALL_BETA]: ["spec.b", "spec.c", "spec.newD"],
};

const SMALL_TO_HUB: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [SMALL_HUB]: {
    "spec.a": "spec.a",
    "spec.b": "spec.b",
    "spec.c": "spec.c",
    "spec.d": "spec.d",
  },
  [SMALL_ALPHA]: {
    "spec.a": "spec.a",
    "spec.oldB": "spec.b",
    "spec.d": "spec.d",
  },
  [SMALL_BETA]: {
    "spec.b": "spec.b",
    "spec.c": "spec.c",
    "spec.newD": "spec.d",
  },
};

const SMALL_DEFAULTS: Readonly<
  Record<string, Readonly<Record<string, JsonValue>>>
> = {
  [SMALL_HUB]: {
    "spec.a": 1,
    "spec.b": "hub-b",
  },
  [SMALL_ALPHA]: {
    "spec.oldB": 7,
  },
  [SMALL_BETA]: {
    "spec.b": "beta-b",
  },
};

export function naiveSmallToHub(source: ResourceObject): ResourceObject {
  const sourceVersion = String(source.apiVersion);
  const result = baseOutput(SMALL_HUB, source, SMALL_RETENTION_KEY);
  const map = SMALL_TO_HUB[sourceVersion];
  if (map === undefined) {
    throw new Error(`naive: unknown source version ${sourceVersion}`);
  }
  for (const [from, to] of Object.entries(map)) {
    if (has(source, from)) {
      put(result, to, clone(get(source, from)));
    }
  }
  const { retained } = stripRetention(source, SMALL_RETENTION_KEY);
  for (const path of Object.keys(retained).sort()) {
    if (!has(result, path)) {
      put(result, path, clone(retained[path]));
    }
  }
  return result as ResourceObject;
}

function smallFromHub(
  hub: ResourceObject,
  targetVersion: string,
): ResourceObject {
  const result = baseOutput(targetVersion, hub, SMALL_RETENTION_KEY);
  const targetMap = SMALL_TO_HUB[targetVersion];
  if (targetMap === undefined) {
    throw new Error(`naive: unknown target version ${targetVersion}`);
  }
  for (const [path, hubPath] of Object.entries(targetMap)) {
    if (has(hub, hubPath)) {
      put(result, path, clone(get(hub, hubPath)));
    }
  }
  const defaults = SMALL_DEFAULTS[targetVersion] ?? {};
  for (const path of Object.keys(defaults).sort()) {
    if (!has(result, path)) {
      put(result, path, clone(defaults[path]));
    }
  }

  const representable = new Set(Object.values(targetMap));
  const retained: Record<string, JsonValue> = {};
  for (const hubField of SMALL_FIELDS[SMALL_HUB]!) {
    if (!representable.has(hubField) && has(hub, hubField)) {
      retained[hubField] = clone(get(hub, hubField));
    }
  }
  if (Object.keys(retained).length > 0) {
    const metadata =
      (result.metadata as Record<string, unknown> | undefined) ?? {};
    const annotations =
      (metadata.annotations as Record<string, unknown> | undefined) ?? {};
    annotations[SMALL_RETENTION_KEY] = canonicalStringify(retained);
    metadata.annotations = annotations;
    result.metadata = metadata;
  }
  return result as ResourceObject;
}

export function naiveConvertSmall(
  source: ResourceObject,
  targetVersion: string,
): ResourceObject {
  return smallFromHub(naiveSmallToHub(source), targetVersion);
}

export function buildResource(
  version: string,
  fields: Readonly<Record<string, unknown>>,
): ResourceObject {
  const resource: Record<string, unknown> = {
    apiVersion: version,
    kind: "Widget",
    metadata: cloneJson(BASE_METADATA),
  };
  for (const [path, value] of Object.entries(fields)) {
    put(resource, path, clone(value));
  }
  return resource as ResourceObject;
}

export { VERSION_FIELDS };
