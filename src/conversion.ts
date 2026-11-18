import { ConversionError } from "./errors.ts";
import {
  assertPlainObject,
  canonicalize,
  canonicalStringify,
  cloneJson,
  compareStrings,
  deepFreeze,
  hasOwn,
  isPlainObject,
  readPath,
  resolvePath,
  safeSet,
  setPath,
  type JsonObject,
  type JsonValue,
  type PathRead,
  type ResourceObject,
} from "./json.ts";

export const DEFAULT_RETENTION_ANNOTATION =
  "conversion.example.io/retained-fields";

export interface FieldMapping {
  /** Field path in the spoke version. */
  readonly from: string;
  /** Field path in the hub version. */
  readonly to: string;
}

export interface DefaultRule {
  /** Field path in the version whose output is being produced. */
  readonly path: string;
  /** Value inserted only when `path` is absent from that output. */
  readonly value: JsonValue;
}

export interface VersionSpec {
  /** Full `apiVersion`, for example `"example.io/v1"`. */
  readonly version: string;
  /**
   * Complete leaf field space of this version. A field omitted from `toHub`
   * is assumed to have the same path in the hub version.
   */
  readonly fields: readonly string[];
  /** Renames/addressing changes from this version to the hub version. */
  readonly toHub?: readonly FieldMapping[];
  /** Defaults applied when this version is the final conversion target. */
  readonly defaults?: readonly DefaultRule[];
}

export interface RetentionConfig {
  /**
   * Annotation that holds the controlled retention record. The default is
   * {@link DEFAULT_RETENTION_ANNOTATION}.
   */
  readonly annotationKey?: string;
}

export interface ConversionTable {
  readonly hubVersion: string;
  readonly versions: readonly VersionSpec[];
  readonly retention?: RetentionConfig;
}

export interface ConversionHooksContext {
  /** Snapshot that the conversion captured before doing any work. */
  readonly snapshotId: number;
  readonly hubVersion: string;
  readonly sourceVersion: string;
  readonly targetVersion: string;
  /** Canonical copy of the intermediate hub resource. */
  readonly hub: ResourceObject;
}

export interface ConversionHooks {
  /**
   * Optional asynchronous observation point between the spoke-to-hub and
   * hub-to-spoke stages. The converter keeps using the snapshot it captured
   * before this hook runs.
   */
  readonly betweenStages?: (
    context: ConversionHooksContext,
  ) => void | Promise<void>;
}

interface CompiledToHubMapping {
  readonly fromPath: string;
  readonly fromSegments: readonly string[];
  readonly hubPath: string;
  readonly hubSegments: readonly string[];
}

interface CompiledFromHubMapping {
  readonly targetPath: string;
  readonly targetSegments: readonly string[];
  readonly hubPath: string;
  readonly hubSegments: readonly string[];
}

interface CompiledDefault {
  readonly path: string;
  readonly segments: readonly string[];
  readonly value: JsonValue;
}

interface CompiledField {
  readonly path: string;
  readonly segments: readonly string[];
}

interface CompiledVersion {
  readonly version: string;
  readonly fields: readonly string[];
  readonly fieldRefs: readonly CompiledField[];
  readonly toHub: readonly CompiledToHubMapping[];
  readonly fromHub: readonly CompiledFromHubMapping[];
  readonly defaults: readonly CompiledDefault[];
  readonly representableHubPaths: readonly string[];
  readonly representableHubSet: Readonly<Record<string, true>>;
  readonly lossyHubFields: readonly string[];
}

interface CompiledTable {
  readonly id: number;
  readonly hubVersion: string;
  readonly retentionKey: string;
  readonly hub: CompiledVersion;
  readonly hubFieldSet: Readonly<Record<string, true>>;
  readonly versionsByKey: Readonly<Record<string, CompiledVersion>>;
  readonly versionOrder: readonly string[];
}

interface ParsedVersion {
  readonly spec: VersionSpec;
  readonly fields: readonly string[];
}

interface ExtractedMetadata {
  readonly present: boolean;
  readonly metadata: JsonObject | undefined;
  readonly retained: readonly (readonly [string, JsonValue])[];
}

/**
 * Deterministic hub-spoke converter with atomically replaceable tables.
 *
 * `convert` always performs `source -> hub -> target`. A conversion captures
 * the current immutable compiled snapshot once, so replacing the table while
 * requests are in flight cannot expose a partially updated table.
 */
export class ResourceConverter {
  #snapshot: CompiledTable;

  constructor(table: ConversionTable) {
    this.#snapshot = compileTable(table, 1);
  }

  /** Monotonically increasing identifier of the currently published table. */
  get snapshotId(): number {
    return this.#snapshot.id;
  }

  get hubVersion(): string {
    return this.#snapshot.hubVersion;
  }

  get retentionAnnotationKey(): string {
    return this.#snapshot.retentionKey;
  }

  get versions(): readonly string[] {
    return this.#snapshot.versionOrder;
  }

  /**
   * Compile a new table completely, then publish it with a single reference
   * assignment. If compilation fails, the previous table remains active.
   *
   * @returns the new snapshot id.
   */
  replaceTable(table: ConversionTable): number {
    const next = compileTable(table, this.#snapshot.id + 1);
    this.#snapshot = next;
    return next.id;
  }

  /** Alias for {@link replaceTable}. */
  swapTable(table: ConversionTable): number {
    return this.replaceTable(table);
  }

  convert(resource: ResourceObject, targetVersion: string): ResourceObject {
    const snapshot = this.#snapshot;
    const { hub } = convertToHub(snapshot, resource);
    return convertFromHub(snapshot, hub, targetVersion);
  }

  /**
   * Asynchronous wrapper for hosts that already operate asynchronously. The
   * table snapshot is captured before the optional hook, so a hot replacement
   * during the hook cannot affect the in-flight conversion.
   */
  async convertAsync(
    resource: ResourceObject,
    targetVersion: string,
    hooks?: ConversionHooks,
  ): Promise<ResourceObject> {
    const snapshot = this.#snapshot;
    const { hub, sourceVersion } = convertToHub(snapshot, resource);
    if (hooks?.betweenStages !== undefined) {
      await hooks.betweenStages({
        snapshotId: snapshot.id,
        hubVersion: snapshot.hubVersion,
        sourceVersion,
        targetVersion,
        hub: canonicalize(hub, "hub") as ResourceObject,
      });
    }
    return convertFromHub(snapshot, hub, targetVersion);
  }
}

export function convertResource(
  table: ConversionTable,
  resource: ResourceObject,
  targetVersion: string,
): ResourceObject {
  return new ResourceConverter(table).convert(resource, targetVersion);
}

function compileTable(table: ConversionTable, id: number): CompiledTable {
  assertPlainObject(table, "conversion table");

  const hubVersion = table.hubVersion;
  if (typeof hubVersion !== "string" || hubVersion.length === 0) {
    throw new ConversionError(
      "invalid_table",
      "conversion table hubVersion must be a non-empty string",
    );
  }

  const rawVersions = table.versions;
  if (!Array.isArray(rawVersions) || rawVersions.length === 0) {
    throw new ConversionError(
      "invalid_table",
      "conversion table versions must be a non-empty array",
    );
  }

  const parsed = new Map<string, ParsedVersion>();
  const versionOrder: string[] = [];
  for (let index = 0; index < rawVersions.length; index += 1) {
    const rawVersion = rawVersions[index];
    if (!isPlainObject(rawVersion)) {
      throw new ConversionError(
        "invalid_table",
        `versions[${index}] must be an object`,
      );
    }
    const version = rawVersion.version;
    if (typeof version !== "string" || version.length === 0) {
      throw new ConversionError(
        "invalid_table",
        `versions[${index}].version must be a non-empty string`,
      );
    }
    if (parsed.has(version)) {
      throw new ConversionError(
        "invalid_table",
        `duplicate version in conversion table: ${JSON.stringify(version)}`,
        { version },
      );
    }
    const fields = compileFields(rawVersion.fields, version);
    parsed.set(version, { spec: rawVersion as unknown as VersionSpec, fields });
    versionOrder.push(version);
  }

  const hubEntry = parsed.get(hubVersion);
  if (hubEntry === undefined) {
    throw new ConversionError(
      "invalid_table",
      `hub version ${JSON.stringify(hubVersion)} is not present in versions`,
      { hubVersion },
    );
  }

  const hubFieldSet = new Set(hubEntry.fields);
  const hubFieldSetRecord: Record<string, true> = Object.create(null);
  for (const hubField of hubEntry.fields) {
    safeSet(hubFieldSetRecord, hubField, true);
  }
  deepFreeze(hubFieldSetRecord);
  const versionsByKey: Record<string, CompiledVersion> = Object.create(null);
  for (const version of versionOrder) {
    const entry = parsed.get(version)!;
    const compiled = compileVersion(
      entry,
      hubEntry.fields,
      hubFieldSet,
      version === hubVersion,
    );
    safeSet(versionsByKey, version, compiled);
  }

  let retentionKey = DEFAULT_RETENTION_ANNOTATION;
  if (table.retention !== undefined) {
    if (!isPlainObject(table.retention)) {
      throw new ConversionError(
        "invalid_table",
        "retention must be an object when present",
      );
    }
    if (table.retention.annotationKey !== undefined) {
      if (
        typeof table.retention.annotationKey !== "string" ||
        table.retention.annotationKey.length === 0
      ) {
        throw new ConversionError(
          "invalid_table",
          "retention.annotationKey must be a non-empty string",
        );
      }
      retentionKey = table.retention.annotationKey;
    }
  }

  return deepFreeze({
    id,
    hubVersion,
    retentionKey,
    hub: versionsByKey[hubVersion]!,
    hubFieldSet: hubFieldSetRecord,
    versionsByKey,
    versionOrder: Object.freeze([...versionOrder]),
  });
}

function compileFields(rawFields: unknown, version: string): readonly string[] {
  if (!Array.isArray(rawFields)) {
    throw new ConversionError(
      "invalid_table",
      `fields for version ${JSON.stringify(version)} must be an array`,
      { version },
    );
  }

  const paths: string[] = [];
  const unique = new Set<string>();
  for (let index = 0; index < rawFields.length; index += 1) {
    const rawPath = rawFields[index];
    if (typeof rawPath !== "string") {
      throw new ConversionError(
        "invalid_table",
        `fields for version ${JSON.stringify(version)} must contain only strings`,
        { version, index },
      );
    }
    const resolved = resolvePath(
      rawPath,
      `versions[${JSON.stringify(version)}].fields[${index}]`,
    );
    const root = resolved.segments[0];
    if (root === "apiVersion" || root === "kind" || root === "metadata") {
      throw new ConversionError(
        "invalid_table",
        `field ${JSON.stringify(rawPath)} is structural and cannot be declared in a version schema`,
        { version, path: rawPath },
      );
    }
    if (unique.has(resolved.path)) {
      throw new ConversionError(
        "invalid_table",
        `duplicate field ${JSON.stringify(rawPath)} in version ${JSON.stringify(version)}`,
        { version, path: rawPath },
      );
    }
    unique.add(resolved.path);
    paths.push(resolved.path);
  }

  // Ancestor and descendant fields overlap and would make mapping order
  // observable, so reject them rather than relying on traversal order.
  for (const path of paths) {
    const segments = resolvePath(path).segments;
    let prefix = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      prefix = prefix === "" ? segments[index]! : `${prefix}.${segments[index]}`;
      if (unique.has(prefix)) {
        throw new ConversionError(
          "invalid_table",
          `fields ${JSON.stringify(prefix)} and ${JSON.stringify(path)} overlap in version ${JSON.stringify(version)}`,
          { version, ancestor: prefix, descendant: path },
        );
      }
    }
  }

  return Object.freeze([...unique].sort(compareStrings));
}

function compileVersion(
  entry: ParsedVersion,
  hubFields: readonly string[],
  hubFieldSet: ReadonlySet<string>,
  isHub: boolean,
): CompiledVersion {
  const { spec, fields } = entry;
  const fieldSet = new Set(fields);
  const rawMappings = spec.toHub ?? [];
  if (!Array.isArray(rawMappings)) {
    throw new ConversionError(
      "invalid_table",
      `toHub for version ${JSON.stringify(spec.version)} must be an array`,
      { version: spec.version },
    );
  }

  const explicitDestinations = new Map<string, string>();
  for (let index = 0; index < rawMappings.length; index += 1) {
    const rawMapping = rawMappings[index];
    if (!isPlainObject(rawMapping)) {
      throw new ConversionError(
        "invalid_mapping",
        `toHub[${index}] for version ${JSON.stringify(spec.version)} must be an object`,
        { version: spec.version, index },
      );
    }
    const from = rawMapping.from;
    const to = rawMapping.to;
    if (typeof from !== "string" || typeof to !== "string") {
      throw new ConversionError(
        "invalid_mapping",
        `toHub[${index}] for version ${JSON.stringify(spec.version)} must have string from/to paths`,
        { version: spec.version, index },
      );
    }
    if (!fieldSet.has(from)) {
      throw new ConversionError(
        "invalid_mapping",
        `mapping source ${JSON.stringify(from)} is not a declared field of version ${JSON.stringify(spec.version)}`,
        { version: spec.version, from },
      );
    }
    if (explicitDestinations.has(from)) {
      throw new ConversionError(
        "invalid_mapping",
        `duplicate mapping source ${JSON.stringify(from)} in version ${JSON.stringify(spec.version)}`,
        { version: spec.version, from },
      );
    }
    resolvePath(from, `toHub[${index}].from`);
    resolvePath(to, `toHub[${index}].to`);
    if (!hubFieldSet.has(to)) {
      throw new ConversionError(
        "invalid_mapping",
        `mapping destination ${JSON.stringify(to)} is not a hub field`,
        { version: spec.version, to },
      );
    }
    explicitDestinations.set(from, to);
  }

  const destinations = new Set<string>();
  const toHub: CompiledToHubMapping[] = [];
  for (const field of fields) {
    const hubPath = explicitDestinations.get(field) ?? field;
    if (!hubFieldSet.has(hubPath)) {
      throw new ConversionError(
        "invalid_mapping",
        `field ${JSON.stringify(field)} of version ${JSON.stringify(spec.version)} has no hub field; declare an explicit toHub mapping`,
        { version: spec.version, field },
      );
    }
    if (destinations.has(hubPath)) {
      throw new ConversionError(
        "invalid_mapping",
        `multiple fields of version ${JSON.stringify(spec.version)} map to hub field ${JSON.stringify(hubPath)}`,
        { version: spec.version, hubPath },
      );
    }
    destinations.add(hubPath);
    if (isHub && hubPath !== field) {
      throw new ConversionError(
        "invalid_mapping",
        `hub field ${JSON.stringify(field)} must map to itself`,
        { version: spec.version, field, hubPath },
      );
    }
    const fromResolved = resolvePath(field, "field");
    const hubResolved = resolvePath(hubPath, "hub field");
    toHub.push({
      fromPath: field,
      fromSegments: fromResolved.segments,
      hubPath,
      hubSegments: hubResolved.segments,
    });
  }
  toHub.sort((left, right) =>
    compareStrings(left.fromPath, right.fromPath),
  );

  const fromHub: CompiledFromHubMapping[] = toHub
    .map((mapping) => ({
      targetPath: mapping.fromPath,
      targetSegments: mapping.fromSegments,
      hubPath: mapping.hubPath,
      hubSegments: mapping.hubSegments,
    }))
    .sort((left, right) => {
      const byHub = compareStrings(left.hubPath, right.hubPath);
      return byHub !== 0
        ? byHub
        : compareStrings(left.targetPath, right.targetPath);
    });

  const rawDefaults = spec.defaults ?? [];
  if (!Array.isArray(rawDefaults)) {
    throw new ConversionError(
      "invalid_table",
      `defaults for version ${JSON.stringify(spec.version)} must be an array`,
      { version: spec.version },
    );
  }
  const defaultPaths = new Set<string>();
  const defaults: CompiledDefault[] = [];
  for (let index = 0; index < rawDefaults.length; index += 1) {
    const rawDefault = rawDefaults[index];
    if (!isPlainObject(rawDefault)) {
      throw new ConversionError(
        "invalid_default",
        `defaults[${index}] for version ${JSON.stringify(spec.version)} must be an object`,
        { version: spec.version, index },
      );
    }
    const path = rawDefault.path;
    if (typeof path !== "string") {
      throw new ConversionError(
        "invalid_default",
        `defaults[${index}].path for version ${JSON.stringify(spec.version)} must be a string`,
        { version: spec.version, index },
      );
    }
    if (!fieldSet.has(path)) {
      throw new ConversionError(
        "invalid_default",
        `default path ${JSON.stringify(path)} is not a declared field of version ${JSON.stringify(spec.version)}`,
        { version: spec.version, path },
      );
    }
    if (defaultPaths.has(path)) {
      throw new ConversionError(
        "invalid_default",
        `duplicate default path ${JSON.stringify(path)} in version ${JSON.stringify(spec.version)}`,
        { version: spec.version, path },
      );
    }
    defaultPaths.add(path);
    const resolved = resolvePath(path, "default path");
    const value = deepFreeze(
      cloneJson(rawDefault.value, `default ${path}`),
    );
    defaults.push({ path, segments: resolved.segments, value });
  }
  defaults.sort((left, right) => compareStrings(left.path, right.path));

  const representableHubPaths = Object.freeze(
    [...destinations].sort(compareStrings),
  );
  const representableHubSet: Record<string, true> = Object.create(null);
  for (const hubPath of representableHubPaths) {
    safeSet(representableHubSet, hubPath, true);
  }
  deepFreeze(representableHubSet);

  const lossyHubFields = Object.freeze(
    hubFields.filter((hubField) => !destinations.has(hubField)),
  );

  const fieldRefs = Object.freeze(
    fields.map((path) => {
      const resolved = resolvePath(path);
      return Object.freeze({
        path,
        segments: resolved.segments,
      });
    }),
  );

  return deepFreeze({
    version: spec.version,
    fields: Object.freeze([...fields]),
    fieldRefs,
    toHub: Object.freeze(toHub),
    fromHub: Object.freeze(fromHub),
    defaults: Object.freeze(defaults),
    representableHubPaths,
    representableHubSet,
    lossyHubFields,
  });
}

function convertToHub(
  snapshot: CompiledTable,
  resource: ResourceObject,
): { hub: ResourceObject; sourceVersion: string } {
  assertPlainObject(resource, "resource");
  const sourceVersion = readSourceVersion(resource, snapshot);
  const source = snapshot.versionsByKey[sourceVersion]!;
  const extracted = extractMetadata(
    resource,
    snapshot.retentionKey,
    snapshot.hubFieldSet,
  );

  const hub: JsonObject = {};
  safeSet(hub, "apiVersion", snapshot.hubVersion);
  if (hasOwn(resource, "kind")) {
    safeSet(hub, "kind", cloneJson(resource.kind, "kind"));
  }
  if (extracted.present) {
    safeSet(hub, "metadata", extracted.metadata!);
  }

  for (const mapping of source.toHub) {
    const value = readPath(resource, mapping.fromSegments);
    if (value.found) {
      setPath(
        hub,
        mapping.hubSegments,
        cloneJson(value.value, mapping.fromPath),
      );
    }
  }

  // Restore retained values one by one. An explicit value already present in
  // the spoke representation wins over a stale retained entry.
  for (const [hubPath, value] of extracted.retained) {
    const resolved = resolvePath(hubPath, "retained field");
    const existing = readPath(hub, resolved.segments);
    if (!existing.found) {
      setPath(hub, resolved.segments, cloneJson(value, hubPath));
    }
  }

  return { hub, sourceVersion };
}

function convertFromHub(
  snapshot: CompiledTable,
  hub: ResourceObject,
  targetVersion: string,
): ResourceObject {
  if (
    typeof targetVersion !== "string" ||
    !hasOwn(snapshot.versionsByKey, targetVersion)
  ) {
    throw new ConversionError(
      "unknown_version",
      `unknown target version ${JSON.stringify(targetVersion)}`,
      { targetVersion, versions: snapshot.versionOrder },
    );
  }
  const target = snapshot.versionsByKey[targetVersion]!;
  const extracted = extractMetadata(
    hub,
    snapshot.retentionKey,
    snapshot.hubFieldSet,
  );
  const retainedFromHub: Record<string, JsonValue> = Object.create(null);
  for (const [path, value] of extracted.retained) {
    safeSet(retainedFromHub, path, value);
  }

  const result: JsonObject = {};
  safeSet(result, "apiVersion", targetVersion);
  if (hasOwn(hub, "kind")) {
    safeSet(result, "kind", cloneJson(hub.kind, "kind"));
  }
  if (extracted.present) {
    safeSet(result, "metadata", extracted.metadata!);
  }

  const readHubValue = (
    path: string,
    segments: readonly string[],
  ): PathRead => {
    const direct = readPath(hub, segments);
    if (direct.found) {
      return direct;
    }
    if (hasOwn(retainedFromHub, path)) {
      return { found: true, value: retainedFromHub[path]! };
    }
    return direct;
  };

  for (const mapping of target.fromHub) {
    const value = readHubValue(mapping.hubPath, mapping.hubSegments);
    if (value.found) {
      setPath(
        result,
        mapping.targetSegments,
        cloneJson(value.value, mapping.hubPath),
      );
    }
  }

  // Defaults belong only to the final target representation. Applying them at
  // the intermediate hub stage would let hub defaults win over target defaults
  // when the source field is absent.
  for (const rule of target.defaults) {
    const existing = readPath(result, rule.segments);
    if (!existing.found) {
      setPath(result, rule.segments, cloneJson(rule.value, rule.path));
    }
  }

  const retained: JsonObject = {};
  for (const hubField of snapshot.hub.fieldRefs) {
    if (hasOwn(target.representableHubSet, hubField.path)) {
      continue;
    }
    const value = readHubValue(hubField.path, hubField.segments);
    if (value.found) {
      safeSet(
        retained,
        hubField.path,
        cloneJson(value.value, hubField.path),
      );
    }
  }
  attachRetention(result, snapshot.retentionKey, retained);

  return canonicalize(result, "converted resource") as ResourceObject;
}

function readSourceVersion(
  resource: Record<string, unknown>,
  snapshot: CompiledTable,
): string {
  const apiVersion = resource.apiVersion;
  if (typeof apiVersion !== "string" || apiVersion.length === 0) {
    throw new ConversionError(
      "invalid_resource",
      "resource.apiVersion must be a non-empty string",
    );
  }
  if (!hasOwn(snapshot.versionsByKey, apiVersion)) {
    throw new ConversionError(
      "unknown_version",
      `unknown source version ${JSON.stringify(apiVersion)}`,
      { sourceVersion: apiVersion, versions: snapshot.versionOrder },
    );
  }
  return apiVersion;
}

function extractMetadata(
  source: Record<string, unknown>,
  retentionKey: string,
  allowedRetainedFields: Readonly<Record<string, true>>,
): ExtractedMetadata {
  if (!hasOwn(source, "metadata")) {
    return {
      present: false,
      metadata: undefined,
      retained: Object.freeze([]),
    };
  }

  const rawMetadata = source.metadata;
  if (!isPlainObject(rawMetadata)) {
    throw new ConversionError(
      "invalid_metadata",
      "resource.metadata must be an object",
    );
  }
  const metadata = cloneJson(rawMetadata, "metadata") as JsonObject;
  if (!hasOwn(metadata, "annotations")) {
    return {
      present: true,
      metadata,
      retained: Object.freeze([]),
    };
  }

  const rawAnnotations = metadata.annotations;
  if (!isPlainObject(rawAnnotations)) {
    throw new ConversionError(
      "invalid_metadata",
      "resource.metadata.annotations must be an object",
    );
  }
  const annotations = cloneJson(
    rawAnnotations,
    "metadata.annotations",
  ) as JsonObject;
  if (!hasOwn(annotations, retentionKey)) {
    return {
      present: true,
      metadata,
      retained: Object.freeze([]),
    };
  }

  const rawRetention = annotations[retentionKey];
  if (typeof rawRetention !== "string") {
    throw new ConversionError(
      "invalid_retention",
      `metadata.annotations[${JSON.stringify(retentionKey)}] must be a JSON string`,
      { annotationKey: retentionKey },
    );
  }
  const parsed = parseRetention(rawRetention, retentionKey);
  const retained: Array<readonly [string, JsonValue]> = [];
  for (const path of Object.keys(parsed).sort(compareStrings)) {
    resolvePath(path, "retained field");
    if (!hasOwn(allowedRetainedFields, path)) {
      throw new ConversionError(
        "invalid_retention",
        `retained field ${JSON.stringify(path)} is not a hub field`,
        { annotationKey: retentionKey, path },
      );
    }
    retained.push(
      Object.freeze([path, parsed[path]!] as const) as readonly [
        string,
        JsonValue,
      ],
    );
  }
  validateNonOverlappingPaths(
    Object.keys(parsed),
    "retained field",
    "invalid_retention",
  );

  delete annotations[retentionKey];
  if (Object.keys(annotations).length === 0) {
    delete metadata.annotations;
  } else {
    safeSet(metadata, "annotations", annotations);
  }

  return {
    present: true,
    metadata,
    retained: Object.freeze(retained),
  };
}

function parseRetention(raw: string, retentionKey: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConversionError(
      "invalid_retention",
      `metadata.annotations[${JSON.stringify(retentionKey)}] is not valid JSON`,
      {
        annotationKey: retentionKey,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  if (!isPlainObject(parsed)) {
    throw new ConversionError(
      "invalid_retention",
      `metadata.annotations[${JSON.stringify(retentionKey)}] must contain a JSON object`,
      { annotationKey: retentionKey },
    );
  }
  try {
    return cloneJson(parsed, "retention") as JsonObject;
  } catch (error) {
    if (error instanceof ConversionError) {
      throw new ConversionError(
        "invalid_retention",
        `retention record contains an invalid JSON value: ${error.message}`,
        { annotationKey: retentionKey, cause: error.code },
      );
    }
    throw error;
  }
}

function validateNonOverlappingPaths(
  paths: readonly string[],
  label: string,
  code: string,
): void {
  const unique = new Set(
    paths.map((path) => resolvePath(path, label).path),
  );
  for (const path of unique) {
    const segments = resolvePath(path, label).segments;
    let prefix = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      prefix = prefix === "" ? segments[index]! : `${prefix}.${segments[index]}`;
      if (unique.has(prefix)) {
        throw new ConversionError(
          code,
          `${label} paths ${JSON.stringify(prefix)} and ${JSON.stringify(path)} overlap`,
          { ancestor: prefix, descendant: path },
        );
      }
    }
  }
}

function attachRetention(
  result: JsonObject,
  retentionKey: string,
  entries: JsonObject,
): void {
  if (Object.keys(entries).length === 0) {
    return;
  }

  let metadata: Record<string, unknown>;
  if (hasOwn(result, "metadata")) {
    const existing = result.metadata;
    if (!isPlainObject(existing)) {
      throw new ConversionError(
        "invalid_metadata",
        "converted resource.metadata must be an object",
      );
    }
    metadata = existing;
  } else {
    metadata = {};
    safeSet(result, "metadata", metadata);
  }

  let annotations: Record<string, unknown>;
  if (hasOwn(metadata, "annotations")) {
    const existing = metadata.annotations;
    if (!isPlainObject(existing)) {
      throw new ConversionError(
        "invalid_metadata",
        "converted resource.metadata.annotations must be an object",
      );
    }
    annotations = existing;
  } else {
    annotations = {};
    safeSet(metadata, "annotations", annotations);
  }
  safeSet(annotations, retentionKey, canonicalStringify(entries, "retention"));
}

export type {
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ResourceObject,
} from "./json.ts";
