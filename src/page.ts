import { DeltaFormatError } from "./errors.js";
import type {
  DeltaChange,
  DeltaRemoval,
  DeltaUpdate,
  ODataEntity,
  ParseDeltaPageOptions,
  ParsedDeltaPage,
  ServerVersion,
} from "./types.js";

const NEXT_LINK_KEYS = [
  "@odata.nextLink",
  "nextLink",
  "@nextLink",
] as const;

const DELTA_LINK_KEYS = [
  "@odata.deltaLink",
  "deltaLink",
  "@deltaLink",
] as const;

const ID_KEYS = ["@odata.id", "id", "ID", "Id", "@id", "key"] as const;

const VERSION_KEYS = [
  "@version",
  "version",
  "Version",
  "_version",
  "rowVersion",
  "RowVersion",
  "@odata.etag",
  "etag",
  "ETag",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readLink(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const link = nonEmptyString(record[key]);
    if (link !== undefined) {
      return link;
    }
  }
  return undefined;
}

function toId(value: unknown): string | undefined {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return nonEmptyString(String(value));
  }
  return undefined;
}

/**
 * Default entity identity. `@odata.id` is preferred because tombstones
 * normally contain only that annotation; an update and its tombstone must
 * therefore resolve to the same key.
 */
export function defaultGetId(entry: ODataEntity): string | undefined {
  for (const key of ID_KEYS) {
    const id = toId(entry[key]);
    if (id !== undefined) {
      return id;
    }
  }
  return undefined;
}

export function normalizeServerVersion(
  value: unknown,
): ServerVersion | undefined {
  if (typeof value === "string") {
    return nonEmptyString(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "bigint") {
    return value;
  }
  return undefined;
}

/**
 * Default server version selector. An explicit version field is preferred over
 * an ETag because it is normally directly comparable and present on
 * tombstones too.
 */
export function defaultGetVersion(
  entry: ODataEntity,
): ServerVersion | undefined {
  for (const key of VERSION_KEYS) {
    const version = normalizeServerVersion(entry[key]);
    if (version !== undefined) {
      return version;
    }
  }
  return undefined;
}

function readRemovalReason(value: unknown): string | undefined {
  if (typeof value === "string") {
    return nonEmptyString(value);
  }
  if (isRecord(value)) {
    return nonEmptyString(value.reason);
  }
  return undefined;
}

function parseEntry<T extends ODataEntity>(
  entry: unknown,
  index: number,
  options: Required<Pick<ParseDeltaPageOptions, "getId" | "getVersion">>,
  url: string | undefined,
): DeltaChange<T> {
  const location = url === undefined ? "" : ` at ${url}`;
  if (!isRecord(entry)) {
    throw new DeltaFormatError(
      `Delta page entry ${index}${location} must be a JSON object`,
      { url },
    );
  }

  const id = toId(options.getId(entry));
  if (id === undefined) {
    throw new DeltaFormatError(
      `Delta page entry ${index}${location} has no usable entity id`,
      { url },
    );
  }

  const version = normalizeServerVersion(options.getVersion(entry));
  const removed = entry["@removed"];
  const isRemoved = removed !== undefined && removed !== null && removed !== false;

  if (isRemoved) {
    const reason = readRemovalReason(removed);
    const removal: DeltaRemoval =
      version === undefined
        ? reason === undefined
          ? { kind: "removed", id }
          : { kind: "removed", id, reason }
        : reason === undefined
          ? { kind: "removed", id, version }
          : { kind: "removed", id, version, reason };
    return removal;
  }

  const update: DeltaUpdate<T> =
    version === undefined
      ? { kind: "update", id, entity: entry as T }
      : { kind: "update", id, version, entity: entry as T };
  return update;
}

function readEntries(input: unknown, url: string | undefined): unknown[] {
  if (Array.isArray(input)) {
    return input;
  }
  if (!isRecord(input)) {
    throw new DeltaFormatError(
      `Delta page${url === undefined ? "" : ` at ${url}`} must be a JSON object or array`,
      { url },
    );
  }

  if (Array.isArray(input.value)) {
    return input.value;
  }
  if (Array.isArray(input.entities)) {
    return input.entities;
  }
  throw new DeltaFormatError(
    `Delta page${url === undefined ? "" : ` at ${url}`} is missing a "value" array`,
    { url },
  );
}

/**
 * Parses one OData delta page, including intermediate pages that only carry a
 * nextLink and the final page that carries a deltaLink.
 */
export function parseDeltaPage<T extends ODataEntity = ODataEntity>(
  input: unknown,
  options: ParseDeltaPageOptions = {},
): ParsedDeltaPage<T> {
  const url = options.url;
  const entries = readEntries(input, url);
  const record = isRecord(input) ? input : {};
  const selectors = {
    getId: options.getId ?? options.getKey ?? defaultGetId,
    getVersion: options.getVersion ?? defaultGetVersion,
  };

  const changes = entries.map((entry, index) =>
    parseEntry<T>(entry, index, selectors, url),
  );

  const nextLink = readLink(record, NEXT_LINK_KEYS);
  const deltaLink = readLink(record, DELTA_LINK_KEYS);

  return {
    changes,
    ...(nextLink === undefined ? {} : { nextLink }),
    ...(deltaLink === undefined ? {} : { deltaLink }),
    raw: input,
  };
}
