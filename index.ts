export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ResourceIdentifier {
  type: string;
  id: string;
  lid?: string;
  meta?: Record<string, JsonValue>;
}

export interface RelationshipObject {
  data?: ResourceIdentifier | ResourceIdentifier[] | null;
  links?: Record<string, JsonValue>;
  meta?: Record<string, JsonValue>;
}

export interface ResourceObject {
  type: string;
  id: string;
  lid?: string;
  attributes?: Record<string, JsonValue>;
  relationships?: Record<string, RelationshipObject>;
  links?: Record<string, JsonValue>;
  meta?: Record<string, JsonValue>;
}

export interface JsonApiDocument {
  data?: ResourceObject | ResourceObject[] | null;
  included?: ResourceObject[];
  links?: Record<string, JsonValue>;
  meta?: Record<string, JsonValue>;
  jsonapi?: Record<string, JsonValue>;
  errors?: JsonValue[];
}

export interface MergedRelationship {
  data?: ResourceIdentifier | ResourceIdentifier[] | null;
  links?: Record<string, JsonValue>;
  meta?: Record<string, JsonValue>;
  readonly linkageKnown: boolean;
}

export interface MergedResource {
  type: string;
  id: string;
  lid?: string;
  attributes?: Record<string, JsonValue>;
  relationships?: Record<string, MergedRelationship>;
  links?: Record<string, JsonValue>;
  meta?: Record<string, JsonValue>;
  readonly key: string;
}

export interface MissingLinkage extends ResourceIdentifier {
  readonly source?: ResourceIdentifier;
  readonly relationship?: string;
  readonly path?: string;
}

export type MergeConflictKind =
  | "lid"
  | "attribute"
  | "relationship"
  | "link"
  | "meta";

export interface MergeConflict {
  readonly resource: ResourceIdentifier;
  readonly kind: MergeConflictKind;
  readonly path: string;
  readonly previous: unknown;
  readonly incoming: unknown;
  readonly previousSource?: number;
  readonly incomingSource?: number;
}

export interface MergeOptions {
  rejectConflicts?: boolean;
  linkageMerge?: "strict" | "union";
  validateJsonValues?: boolean;
}

export interface ResolveOptions extends MergeOptions {
  roots?: ResourceIdentifier | ResourceIdentifier[] | null;
  rootMode?: "data" | "all";
}

export interface ResourceCollection extends Array<MergedResource> {
  get(type: string, id?: string): MergedResource | undefined;
  has(type: string, id?: string): boolean;
  readonly size: number;
  readonly byKey: ReadonlyMap<string, MergedResource>;
}

export interface MergeResult {
  readonly resources: ResourceCollection;
  readonly roots: ResourceCollection;
  readonly missing: MissingLinkage[];
  readonly all: ResourceCollection;
  readonly closure: ResourceCollection;
  readonly reachable: ResourceCollection;
  readonly included: ResourceCollection;
  readonly missingLinkage: MissingLinkage[];
  readonly conflicts: MergeConflict[];
  readonly byKey: ReadonlyMap<string, MergedResource>;
  readonly resourceMap: ReadonlyMap<string, MergedResource>;
  readonly index: ReadonlyMap<string, MergedResource>;
  get(type: string, id?: string): MergedResource | undefined;
  has(type: string, id?: string): boolean;
  readonly size: number;
  [Symbol.iterator](): IterableIterator<MergedResource>;
}

export type JsonApiInput =
  | JsonApiDocument
  | JsonApiDocument[]
  | ResourceObject
  | ResourceObject[]
  | string;

type JsonRecord = Record<string, unknown>;

interface InternalRelationship {
  dataKnown: boolean;
  linkage?: ResourceIdentifier | ResourceIdentifier[] | null;
  links: Map<string, JsonValue>;
  meta: Map<string, JsonValue>;
  source: number;
}

interface InternalResource {
  type: string;
  id: string;
  key: string;
  lid?: JsonValue;
  attributes: Map<string, JsonValue>;
  relationships: Map<string, InternalRelationship>;
  links: Map<string, JsonValue>;
  meta: Map<string, JsonValue>;
  firstSource: number;
}

interface MutableState {
  resources: Map<string, InternalResource>;
  order: string[];
  roots: string[];
  conflicts: MergeConflict[];
  sourceCounter: number;
}

interface NormalizedInput {
  documents: JsonApiDocument[];
  standaloneResources: ResourceObject[];
  explicitRoots?: ResourceIdentifier[] | null;
}

export class JsonApiParseError extends Error {
  readonly code = "JSON_API_PARSE_ERROR";
  readonly path: string;

  constructor(message: string, path = "$") {
    super(`${message} at ${path}`);
    this.name = "JsonApiParseError";
    this.path = path;
  }
}

export class JsonApiMergeConflictError extends Error {
  readonly code = "JSON_API_MERGE_CONFLICT";
  readonly conflicts: MergeConflict[];

  constructor(conflicts: MergeConflict[]) {
    const first = conflicts[0];
    const suffix = conflicts.length === 1 ? "" : ` (${conflicts.length} conflicts)`;
    super(`JSON:API merge conflict at ${first?.path ?? "$"}${suffix}`);
    this.name = "JsonApiMergeConflictError";
    this.conflicts = conflicts;
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is JsonRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function resourceKey(type: string, id: string): string {
  return `${type}\u0000${id}`;
}

function displayKey(type: string, id: string): string {
  return `${type}:${id}`;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqual(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) {
      return false;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    for (const key of leftKeys) {
      if (!hasOwn(right, key) || !deepEqual(left[key], right[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function cloneJson<T = JsonValue>(
  value: unknown,
  path: string,
  validate: boolean,
  seen = new WeakSet<object>(),
): T {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value as T;
  }
  if (typeof value === "number") {
    if (validate && !Number.isFinite(value)) {
      throw new JsonApiParseError("JSON number must be finite", path);
    }
    return value as T;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new JsonApiParseError("cyclic value is not valid JSON", path);
    }
    seen.add(value);
    const copy = value.map((item, index) =>
      cloneJson(item, `${path}[${index}]`, validate, seen),
    );
    seen.delete(value);
    return copy as T;
  }
  if (isRecord(value)) {
    if (seen.has(value)) {
      throw new JsonApiParseError("cyclic value is not valid JSON", path);
    }
    seen.add(value);
    const copy: JsonRecord = {};
    for (const [key, item] of Object.entries(value)) {
      if (validate && item === undefined) {
        throw new JsonApiParseError("undefined is not valid JSON", `${path}.${key}`);
      }
      if (
        validate &&
        (typeof item === "function" ||
          typeof item === "symbol" ||
          typeof item === "bigint")
      ) {
        throw new JsonApiParseError("value is not valid JSON", `${path}.${key}`);
      }
      copy[key] = cloneJson(item, `${path}.${key}`, validate, seen);
    }
    seen.delete(value);
    return copy as T;
  }
  if (validate) {
    throw new JsonApiParseError("value is not valid JSON", path);
  }
  return value as T;
}

function parseIdentifier(raw: unknown, path: string): ResourceIdentifier {
  if (!isRecord(raw)) {
    throw new JsonApiParseError("resource identifier must be an object", path);
  }
  if (typeof raw.type !== "string" || raw.type.length === 0) {
    throw new JsonApiParseError("resource identifier type must be a non-empty string", `${path}.type`);
  }
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new JsonApiParseError("resource identifier id must be a non-empty string", `${path}.id`);
  }
  const identifier: ResourceIdentifier = {
    type: raw.type,
    id: raw.id,
  };
  if (hasOwn(raw, "lid")) {
    if (typeof raw.lid !== "string" || raw.lid.length === 0) {
      throw new JsonApiParseError("resource identifier lid must be a non-empty string", `${path}.lid`);
    }
    identifier.lid = raw.lid;
  }
  if (hasOwn(raw, "meta")) {
    if (!isRecord(raw.meta)) {
      throw new JsonApiParseError("resource identifier meta must be an object", `${path}.meta`);
    }
    identifier.meta = cloneJson(raw.meta, `${path}.meta`, true) as Record<string, JsonValue>;
  }
  return identifier;
}

function parseLinkage(
  raw: unknown,
  path: string,
): ResourceIdentifier | ResourceIdentifier[] | null {
  if (raw === null) {
    return null;
  }
  if (Array.isArray(raw)) {
    return raw.map((item, index) => parseIdentifier(item, `${path}[${index}]`));
  }
  return parseIdentifier(raw, path);
}

function relationshipFromRaw(raw: unknown, path: string, source: number): InternalRelationship {
  if (!isRecord(raw)) {
    throw new JsonApiParseError("relationship must be an object", path);
  }
  const relationship: InternalRelationship = {
    dataKnown: hasOwn(raw, "data"),
    links: new Map(),
    meta: new Map(),
    source,
  };
  if (hasOwn(raw, "data")) {
    relationship.linkage = parseLinkage(raw.data, `${path}.data`);
  }
  if (hasOwn(raw, "links")) {
    if (!isRecord(raw.links)) {
      throw new JsonApiParseError("relationship links must be an object", `${path}.links`);
    }
    for (const [key, value] of Object.entries(raw.links)) {
      relationship.links.set(
        key,
        cloneJson<JsonValue>(value, `${path}.links.${key}`, true),
      );
    }
  }
  if (hasOwn(raw, "meta")) {
    if (!isRecord(raw.meta)) {
      throw new JsonApiParseError("relationship meta must be an object", `${path}.meta`);
    }
    for (const [key, value] of Object.entries(raw.meta)) {
      relationship.meta.set(
        key,
        cloneJson<JsonValue>(value, `${path}.meta.${key}`, true),
      );
    }
  }
  return relationship;
}

function linkageIdentity(identifier: ResourceIdentifier): string {
  return resourceKey(identifier.type, identifier.id);
}

function unionLinkage(
  left: ResourceIdentifier[],
  right: ResourceIdentifier[],
): ResourceIdentifier[] {
  const result = left.slice();
  const seen = new Set(left.map(linkageIdentity));
  for (const identifier of right) {
    const key = linkageIdentity(identifier);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(identifier);
    }
  }
  return result;
}

function mergeLinkage(
  left: ResourceIdentifier | ResourceIdentifier[] | null,
  right: ResourceIdentifier | ResourceIdentifier[] | null,
  mode: "strict" | "union",
): ResourceIdentifier | ResourceIdentifier[] | null {
  if (deepEqual(left, right)) {
    return left;
  }
  if (
    mode === "union" &&
    Array.isArray(left) &&
    Array.isArray(right)
  ) {
    return unionLinkage(left, right);
  }
  if (
    mode === "union" &&
    (left === null || Array.isArray(left)) &&
    (right === null || Array.isArray(right))
  ) {
    const leftArray = left ?? [];
    const rightArray = right ?? [];
    return unionLinkage(leftArray, rightArray);
  }
  return left;
}

function addConflict(
  state: MutableState,
  resource: InternalResource,
  kind: MergeConflictKind,
  path: string,
  previous: unknown,
  incoming: unknown,
  previousSource: number | undefined,
  incomingSource: number,
): void {
  state.conflicts.push({
    resource: { type: resource.type, id: resource.id },
    kind,
    path,
    previous,
    incoming,
    previousSource,
    incomingSource,
  });
}

function mergeFieldMap(
  state: MutableState,
  resource: InternalResource,
  target: Map<string, JsonValue>,
  incoming: JsonRecord,
  basePath: string,
  kind: "link" | "meta",
  source: number,
): void {
  for (const [key, rawValue] of Object.entries(incoming)) {
    const value = cloneJson<JsonValue>(rawValue, `${basePath}.${key}`, true);
    if (target.has(key)) {
      const previous = target.get(key);
      if (!deepEqual(previous, value)) {
        addConflict(
          state,
          resource,
          kind,
          `${displayKey(resource.type, resource.id)}.${basePath}.${key}`,
          previous,
          value,
          undefined,
          source,
        );
      }
      continue;
    }
    target.set(key, value);
  }
}

function mergeRelationship(
  state: MutableState,
  resource: InternalResource,
  existing: InternalRelationship | undefined,
  incoming: InternalRelationship,
  name: string,
  options: Required<Pick<MergeOptions, "rejectConflicts" | "linkageMerge">>,
): InternalRelationship {
  if (existing === undefined) {
    return incoming;
  }

  const previousKnown = existing.dataKnown;
  const incomingKnown = incoming.dataKnown;
  if (previousKnown && incomingKnown) {
    if (options.linkageMerge === "strict") {
      if (!deepEqual(existing.linkage ?? null, incoming.linkage ?? null)) {
        addConflict(
          state,
          resource,
          "relationship",
          `${displayKey(resource.type, resource.id)}.relationships.${name}.data`,
          existing.linkage,
          incoming.linkage,
          existing.source,
          incoming.source,
        );
      }
    } else {
      existing.linkage = mergeLinkage(
        existing.linkage ?? null,
        incoming.linkage ?? null,
        options.linkageMerge,
      );
    }
  } else if (incomingKnown) {
    existing.dataKnown = true;
    existing.linkage = incoming.linkage;
    existing.source = incoming.source;
  }

  mergeFieldMap(
    state,
    resource,
    existing.links,
    Object.fromEntries(incoming.links),
    `relationships.${name}.links`,
    "link",
    incoming.source,
  );
  mergeFieldMap(
    state,
    resource,
    existing.meta,
    Object.fromEntries(incoming.meta),
    `relationships.${name}.meta`,
    "meta",
    incoming.source,
  );

  return existing;
}

function parseResource(
  state: MutableState,
  raw: unknown,
  path: string,
  source: number,
  options: Required<Pick<MergeOptions, "rejectConflicts" | "linkageMerge" | "validateJsonValues">>,
): InternalResource {
  if (!isRecord(raw)) {
    throw new JsonApiParseError("resource must be an object", path);
  }
  if (typeof raw.type !== "string" || raw.type.length === 0) {
    throw new JsonApiParseError("resource type must be a non-empty string", `${path}.type`);
  }
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new JsonApiParseError("resource id must be a non-empty string", `${path}.id`);
  }

  const key = resourceKey(raw.type, raw.id);
  let resource = state.resources.get(key);
  if (resource === undefined) {
    resource = {
      type: raw.type,
      id: raw.id,
      key,
      attributes: new Map(),
      relationships: new Map(),
      links: new Map(),
      meta: new Map(),
      firstSource: source,
    };
    state.resources.set(key, resource);
    state.order.push(key);
  }

  if (hasOwn(raw, "lid")) {
    if (typeof raw.lid !== "string" || raw.lid.length === 0) {
      throw new JsonApiParseError("resource lid must be a non-empty string", `${path}.lid`);
    }
    if (resource.lid !== undefined && !deepEqual(resource.lid, raw.lid)) {
      addConflict(
        state,
        resource,
        "lid",
        `${displayKey(resource.type, resource.id)}.lid`,
        resource.lid,
        raw.lid,
        resource.firstSource,
        source,
      );
    } else {
      resource.lid = raw.lid;
    }
  }

  if (hasOwn(raw, "attributes")) {
    if (!isRecord(raw.attributes)) {
      throw new JsonApiParseError("resource attributes must be an object", `${path}.attributes`);
    }
    for (const [name, rawValue] of Object.entries(raw.attributes)) {
      const value = cloneJson<JsonValue>(
        rawValue,
        `${path}.attributes.${name}`,
        options.validateJsonValues,
      );
      if (resource.attributes.has(name)) {
        const previous = resource.attributes.get(name);
        if (!deepEqual(previous, value)) {
          addConflict(
            state,
            resource,
            "attribute",
            `${displayKey(resource.type, resource.id)}.attributes.${name}`,
            previous,
            value,
            resource.firstSource,
            source,
          );
        }
      } else {
        resource.attributes.set(name, value);
      }
    }
  }

  if (hasOwn(raw, "relationships")) {
    if (!isRecord(raw.relationships)) {
      throw new JsonApiParseError("resource relationships must be an object", `${path}.relationships`);
    }
    for (const [name, rawRelationship] of Object.entries(raw.relationships)) {
      const relationshipPath = `${path}.relationships.${name}`;
      const incoming = relationshipFromRaw(rawRelationship, relationshipPath, source);
      const existing = resource.relationships.get(name);
      resource.relationships.set(
        name,
        mergeRelationship(state, resource, existing, incoming, name, options),
      );
    }
  }

  if (hasOwn(raw, "links")) {
    if (!isRecord(raw.links)) {
      throw new JsonApiParseError("resource links must be an object", `${path}.links`);
    }
    mergeFieldMap(
      state,
      resource,
      resource.links,
      raw.links,
      "links",
      "link",
      source,
    );
  }

  if (hasOwn(raw, "meta")) {
    if (!isRecord(raw.meta)) {
      throw new JsonApiParseError("resource meta must be an object", `${path}.meta`);
    }
    mergeFieldMap(
      state,
      resource,
      resource.meta,
      raw.meta,
      "meta",
      "meta",
      source,
    );
  }

  return resource;
}

function normalizeInput(input: unknown, explicitRoots?: unknown): NormalizedInput {
  let parsed = input;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid JSON";
      throw new JsonApiParseError(`unable to parse JSON: ${message}`);
    }
  }

  if (parsed === null || parsed === undefined) {
    return { documents: [], standaloneResources: [] };
  }

  if (Array.isArray(parsed)) {
    const documents: JsonApiDocument[] = [];
    const standaloneResources: ResourceObject[] = [];
    parsed.forEach((item, index) => {
      if (isRecord(item) && (hasOwn(item, "data") || hasOwn(item, "included") || hasOwn(item, "errors"))) {
        documents.push(item as JsonApiDocument);
      } else if (isRecord(item) && typeof item.type === "string" && typeof item.id === "string") {
        standaloneResources.push(item as unknown as ResourceObject);
      } else {
        throw new JsonApiParseError("item is neither a document nor a resource", `$[${index}]`);
      }
    });
    return {
      documents,
      standaloneResources,
      explicitRoots: normalizeRoots(explicitRoots),
    };
  }

  if (isRecord(parsed) && Array.isArray(parsed.documents)) {
    return {
      ...normalizeInput(parsed.documents, explicitRoots),
      explicitRoots: normalizeRoots(explicitRoots ?? parsed.roots),
    };
  }

  if (
    isRecord(parsed) &&
    (hasOwn(parsed, "data") || hasOwn(parsed, "included") || hasOwn(parsed, "errors"))
  ) {
    return {
      documents: [parsed as JsonApiDocument],
      standaloneResources: [],
      explicitRoots: normalizeRoots(explicitRoots),
    };
  }

  if (isRecord(parsed) && typeof parsed.type === "string" && typeof parsed.id === "string") {
    return {
      documents: [],
      standaloneResources: [parsed as unknown as ResourceObject],
      explicitRoots: normalizeRoots(explicitRoots),
    };
  }

  throw new JsonApiParseError("input must be a JSON:API document or resource");
}

function normalizeRoots(raw: unknown): ResourceIdentifier[] | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === null) {
    return null;
  }
  if (Array.isArray(raw)) {
    return raw.map((item, index) => parseIdentifier(item, `$.roots[${index}]`));
  }
  return [parseIdentifier(raw, "$.roots")];
}

function isOptions(value: unknown): value is MergeOptions {
  return (
    isRecord(value) &&
    !hasOwn(value, "data") &&
    !hasOwn(value, "included") &&
    !hasOwn(value, "type") &&
    !hasOwn(value, "errors")
  );
}

function splitArguments(args: unknown[]): {
  input: unknown;
  options: MergeOptions;
} {
  let options: MergeOptions = {};
  const values = args.slice();
  while (values.length > 0 && values[values.length - 1] === undefined) {
    values.pop();
  }
  if (values.length > 0 && isOptions(values[values.length - 1])) {
    options = values.pop() as MergeOptions;
  }
  if (values.length === 0) {
    return { input: [], options };
  }
  if (values.length === 1) {
    return { input: values[0], options };
  }
  return {
    input: values,
    options,
  };
}

function buildResource(resource: InternalResource): MergedResource {
  const merged = {
    type: resource.type,
    id: resource.id,
  } as MergedResource;
  if (resource.lid !== undefined) {
    merged.lid = resource.lid as string;
  }
  if (resource.attributes.size > 0) {
    merged.attributes = Object.fromEntries(resource.attributes);
  }
  if (resource.relationships.size > 0) {
    const relationships: Record<string, MergedRelationship> = {};
    for (const [name, relationship] of resource.relationships) {
      const output: Record<string, unknown> = {};
      if (relationship.dataKnown) {
        output.data = relationship.linkage;
      }
      if (relationship.links.size > 0) {
        output.links = Object.fromEntries(relationship.links);
      }
      if (relationship.meta.size > 0) {
        output.meta = Object.fromEntries(relationship.meta);
      }
      Object.defineProperty(output, "linkageKnown", {
        value: relationship.dataKnown,
        enumerable: false,
        configurable: false,
      });
      relationships[name] = output as unknown as MergedRelationship;
    }
    merged.relationships = relationships;
  }
  if (resource.links.size > 0) {
    merged.links = Object.fromEntries(resource.links);
  }
  if (resource.meta.size > 0) {
    merged.meta = Object.fromEntries(resource.meta);
  }
  Object.defineProperty(merged, "key", {
    value: displayKey(resource.type, resource.id),
    enumerable: false,
    configurable: false,
  });
  return merged;
}

function makeCollection(
  items: MergedResource[],
  index: ReadonlyMap<string, MergedResource>,
): ResourceCollection {
  const collection = items.slice() as ResourceCollection;
  const members = new Set(
    items.map((resource) => resourceKey(resource.type, resource.id)),
  );
  const find = (type: string, id?: string): MergedResource | undefined => {
    if (id !== undefined) {
      const key = resourceKey(type, id);
      return members.has(key) ? index.get(key) : undefined;
    }
    const direct = index.get(type);
    if (direct !== undefined && members.has(resourceKey(direct.type, direct.id))) {
      return direct;
    }
    for (const resource of index.values()) {
      if (
        displayKey(resource.type, resource.id) === type &&
        members.has(resourceKey(resource.type, resource.id))
      ) {
        return resource;
      }
    }
    return undefined;
  };
  Object.defineProperties(collection, {
    get: {
      value(type: string, id?: string): MergedResource | undefined {
        return find(type, id);
      },
      enumerable: false,
    },
    has: {
      value(type: string, id?: string): boolean {
        return this.get(type, id) !== undefined;
      },
      enumerable: false,
    },
    size: {
      get(): number {
        return this.length;
      },
      enumerable: false,
    },
    byKey: {
      value: index,
      enumerable: false,
    },
  });
  return collection;
}

function defineHidden(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    configurable: true,
  });
}

function makeMissingLinkage(
  identifier: ResourceIdentifier,
  source: ResourceIdentifier,
  relationship: string,
  path: string,
): MissingLinkage {
  const missing: MissingLinkage = {
    type: identifier.type,
    id: identifier.id,
  };
  if (identifier.lid !== undefined) {
    missing.lid = identifier.lid;
  }
  if (identifier.meta !== undefined) {
    missing.meta = identifier.meta;
  }
  defineHidden(missing, "source", source);
  defineHidden(missing, "relationship", relationship);
  defineHidden(missing, "path", path);
  return missing;
}

function resolveClosure(
  state: MutableState,
  rootKeys: string[],
): { closureKeys: Set<string>; missing: MissingLinkage[] } {
  const closureKeys = new Set<string>();
  const missing: MissingLinkage[] = [];
  const missingKeys = new Set<string>();
  const queue: string[] = [];

  for (const key of rootKeys) {
    if (state.resources.has(key) && !closureKeys.has(key)) {
      closureKeys.add(key);
      queue.push(key);
    }
  }

  for (let index = 0; index < queue.length; index += 1) {
    const resourceKeyValue = queue[index];
    const resource = state.resources.get(resourceKeyValue);
    if (resource === undefined) {
      continue;
    }
    for (const [relationshipName, relationship] of resource.relationships) {
      if (!relationship.dataKnown || relationship.linkage === undefined || relationship.linkage === null) {
        continue;
      }
      const identifiers = Array.isArray(relationship.linkage)
        ? relationship.linkage
        : [relationship.linkage];
      identifiers.forEach((identifier, linkageIndex) => {
        const targetKey = resourceKey(identifier.type, identifier.id);
        if (state.resources.has(targetKey)) {
          if (!closureKeys.has(targetKey)) {
            closureKeys.add(targetKey);
            queue.push(targetKey);
          }
          return;
        }
        if (!missingKeys.has(targetKey)) {
          missingKeys.add(targetKey);
          const path = Array.isArray(relationship.linkage)
            ? `relationships.${relationshipName}.data[${linkageIndex}]`
            : `relationships.${relationshipName}.data`;
          missing.push(
            makeMissingLinkage(
              identifier,
              { type: resource.type, id: resource.id },
              relationshipName,
              path,
            ),
          );
        }
      });
    }
  }

  return { closureKeys, missing };
}

function createResult(
  state: MutableState,
  rootKeys: string[],
): MergeResult {
  const allResources = state.order
    .map((key) => state.resources.get(key))
    .filter((resource): resource is InternalResource => resource !== undefined)
    .map(buildResource);
  const index = new Map<string, MergedResource>();
  for (const resource of allResources) {
    index.set(resourceKey(resource.type, resource.id), resource);
  }

  const { closureKeys, missing } = resolveClosure(state, rootKeys);
  const roots = rootKeys
    .map((key) => index.get(key))
    .filter((resource): resource is MergedResource => resource !== undefined);
  const closure = allResources.filter((resource) =>
    closureKeys.has(resourceKey(resource.type, resource.id)),
  );
  const rootSet = new Set(rootKeys);
  const included = closure.filter((resource) =>
    !rootSet.has(resourceKey(resource.type, resource.id)),
  );

  const allCollection = makeCollection(allResources, index);
  const closureCollection = makeCollection(closure, index);
  const rootsCollection = makeCollection(roots, index);
  const includedCollection = makeCollection(included, index);

  const result: MergeResult = {
    resources: closureCollection,
    missing,
  } as MergeResult;

  defineHidden(result, "roots", rootsCollection);
  defineHidden(result, "all", allCollection);
  defineHidden(result, "closure", closureCollection);
  defineHidden(result, "reachable", closureCollection);
  defineHidden(result, "included", includedCollection);
  defineHidden(result, "missingLinkage", missing);
  defineHidden(result, "conflicts", state.conflicts);
  defineHidden(result, "byKey", index);
  defineHidden(result, "resourceMap", index);
  defineHidden(result, "index", index);
  defineHidden(result, "get", (type: string, id?: string) => closureCollection.get(type, id));
  defineHidden(result, "has", (type: string, id?: string) => closureCollection.has(type, id));
  defineHidden(result, "size", closure.length);
  defineHidden(result, Symbol.iterator, () => closureCollection[Symbol.iterator]());
  for (const resource of allResources) {
    const key = displayKey(resource.type, resource.id);
    if (!hasOwn(result, key)) {
      defineHidden(result, key, resource);
    }
  }
  return result;
}

function mergeNormalized(
  normalized: NormalizedInput,
  options: ResolveOptions,
): MergeResult {
  const rejectConflicts = options.rejectConflicts ?? true;
  const linkageMerge = options.linkageMerge ?? "strict";
  const validateJsonValues = options.validateJsonValues ?? true;
  const mergeOptions = {
    rejectConflicts,
    linkageMerge,
    validateJsonValues,
  };
  const state: MutableState = {
    resources: new Map(),
    order: [],
    roots: [],
    conflicts: [],
    sourceCounter: 0,
  };

  const registerRoot = (resource: InternalResource): void => {
    if (!state.roots.includes(resource.key)) {
      state.roots.push(resource.key);
    }
  };

  normalized.standaloneResources.forEach((raw, index) => {
    const source = state.sourceCounter;
    state.sourceCounter += 1;
    const resource = parseResource(
      state,
      raw,
      `$.resources[${index}]`,
      source,
      mergeOptions,
    );
    registerRoot(resource);
  });

  normalized.documents.forEach((document, documentIndex) => {
    if (!isRecord(document)) {
      throw new JsonApiParseError("document must be an object", `$.documents[${documentIndex}]`);
    }
    const documentPath = `$.documents[${documentIndex}]`;
    if (hasOwn(document, "data")) {
      const data = document.data;
      if (data !== null && !Array.isArray(data) && !isRecord(data)) {
        throw new JsonApiParseError("data must be a resource, an array, or null", `${documentPath}.data`);
      }
      if (data !== null) {
        const resources = Array.isArray(data) ? data : [data];
        resources.forEach((raw, index) => {
          const source = state.sourceCounter;
          state.sourceCounter += 1;
          const resource = parseResource(
            state,
            raw,
            Array.isArray(data)
              ? `${documentPath}.data[${index}]`
              : `${documentPath}.data`,
            source,
            mergeOptions,
          );
          registerRoot(resource);
        });
      }
    }
    if (hasOwn(document, "included")) {
      if (!Array.isArray(document.included)) {
        throw new JsonApiParseError("included must be an array", `${documentPath}.included`);
      }
      document.included.forEach((raw, index) => {
        const source = state.sourceCounter;
        state.sourceCounter += 1;
        parseResource(
          state,
          raw,
          `${documentPath}.included[${index}]`,
          source,
          mergeOptions,
        );
      });
    }
  });

  let rootKeys: string[];
  if (normalized.explicitRoots !== undefined) {
    rootKeys = normalized.explicitRoots === null
      ? []
      : normalized.explicitRoots.map((identifier) => resourceKey(identifier.type, identifier.id));
  } else if (options.rootMode === "all") {
    rootKeys = state.order.slice();
  } else {
    rootKeys = state.roots.slice();
  }

  if (state.conflicts.length > 0 && rejectConflicts) {
    throw new JsonApiMergeConflictError(state.conflicts);
  }

  return createResult(state, rootKeys);
}

export function parseJsonApiDocument(input: unknown): JsonApiDocument {
  let parsed = input;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid JSON";
      throw new JsonApiParseError(`unable to parse JSON: ${message}`);
    }
  }
  if (!isRecord(parsed)) {
    throw new JsonApiParseError("document must be an object");
  }
  if (hasOwn(parsed, "included") && !Array.isArray(parsed.included)) {
    throw new JsonApiParseError("included must be an array", "$.included");
  }
  if (hasOwn(parsed, "data")) {
    if (parsed.data !== null && !Array.isArray(parsed.data) && !isRecord(parsed.data)) {
      throw new JsonApiParseError("data must be a resource, an array, or null", "$.data");
    }
  }
  return parsed as JsonApiDocument;
}

export function mergeJsonApiDocuments(
  input: JsonApiInput,
  options?: ResolveOptions,
): MergeResult;
export function mergeJsonApiDocuments(...documents: JsonApiDocument[]): MergeResult;
export function mergeJsonApiDocuments(...args: unknown[]): MergeResult {
  const { input, options } = splitArguments(args);
  const normalized = normalizeInput(input);
  return mergeNormalized(
    {
      ...normalized,
      explicitRoots: normalizeRoots((options as ResolveOptions).roots),
    },
    options as ResolveOptions,
  );
}

export const mergeJsonApiDocument = mergeJsonApiDocuments;
export const mergeDocuments = mergeJsonApiDocuments;
export const mergeJsonApi = mergeJsonApiDocuments;
export const resolveJsonApi = mergeJsonApiDocuments;
export const mergeAndResolve = mergeJsonApiDocuments;
export const normalizeJsonApi = mergeJsonApiDocuments;

export function mergeResources(
  input: ResourceObject | ResourceObject[] | null,
  includedOrOptions?: ResourceObject[] | MergeOptions,
  maybeOptions?: MergeOptions,
): MergeResult {
  let included: ResourceObject[] | undefined;
  let options: MergeOptions = {};
  if (Array.isArray(includedOrOptions)) {
    included = includedOrOptions;
    options = maybeOptions ?? {};
  } else if (includedOrOptions !== undefined) {
    options = includedOrOptions;
  }
  const normalized = normalizeInput(
    included === undefined ? { data: input } : { data: input, included },
  );
  return mergeNormalized(normalized, options);
}

export function buildResourceClosure(
  input: JsonApiInput,
  options?: ResolveOptions,
): MergeResult;
export function buildResourceClosure(...documents: JsonApiDocument[]): MergeResult;
export function buildResourceClosure(...args: unknown[]): MergeResult {
  return (mergeJsonApiDocuments as (...values: unknown[]) => MergeResult)(...args);
}

export function tryMergeJsonApiDocuments(
  input: JsonApiInput,
  options?: ResolveOptions,
): { ok: true; result: MergeResult } | { ok: false; error: JsonApiMergeConflictError } {
  try {
    return { ok: true, result: mergeJsonApiDocuments(input, options) };
  } catch (error) {
    if (error instanceof JsonApiMergeConflictError) {
      return { ok: false, error };
    }
    throw error;
  }
}

export function isJsonApiMergeConflictError(
  error: unknown,
): error is JsonApiMergeConflictError {
  return error instanceof JsonApiMergeConflictError;
}

export function getResourceKey(resource: ResourceIdentifier): string {
  return displayKey(resource.type, resource.id);
}

export const resourceIdentifierKey = getResourceKey;

export const mergeIncluded = mergeJsonApiDocuments;
export const parseDocument = parseJsonApiDocument;
export const parseJsonApi = parseJsonApiDocument;
export const mergeResourceRepresentations = mergeResources;
export const mergeJsonApiIncluded = mergeJsonApiDocuments;
export const buildIncludedClosure = buildResourceClosure;
export const resolveIncludedResources = buildResourceClosure;
export const resolveResourceClosure = buildResourceClosure;
export const safeMergeJsonApiDocuments = tryMergeJsonApiDocuments;

export {
  JsonApiMergeConflictError as MergeConflictError,
  JsonApiMergeConflictError as ConflictError,
  JsonApiParseError as JsonApiDocumentError,
};

const defaultExport = Object.assign(mergeJsonApiDocuments, {
  mergeJsonApiDocument,
  mergeDocuments,
  mergeJsonApi,
  resolveJsonApi,
  mergeResources,
  buildResourceClosure,
  tryMergeJsonApiDocuments,
  parseJsonApiDocument,
  getResourceKey,
});

export default defaultExport;
