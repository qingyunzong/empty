/**
 * Importable cookie snapshot utilities for browser connectors.
 *
 * The two invariants this module is built around are:
 *  - A partitioned cookie is never silently converted into an unpartitioned
 *    cookie. A snapshot for another top-level site is skipped instead.
 *  - Cookie state is versioned by a monotonically increasing response
 *    generation. Deletions are retained as tombstones so an older snapshot or
 *    a late response cannot recreate a cookie that was deleted later.
 */

export const COOKIE_SNAPSHOT_FORMAT = "cookie-snapshot/v1" as const;

export type CookieSnapshotFormat = typeof COOKIE_SNAPSHOT_FORMAT;
export type SameSite = "Strict" | "Lax" | "None";
export type DeletionReason = "set-cookie" | "expired";

export class CookieSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CookieSnapshotError";
  }
}

/** The CHIPS partition key stored with a partitioned cookie. */
export interface CookiePartitionKey {
  /** Schemeful top-level site, for example `https://example.com`. */
  topLevelSite: string;
  /** Whether the cookie was created beneath a cross-site ancestor. */
  hasCrossSiteAncestor: boolean;
}

export interface CookieIdentity {
  name: string;
  /** Canonical domain. Domain cookies include the leading dot. */
  domain: string;
  path: string;
  hostOnly: boolean;
  /** `null` means the cookie is unpartitioned. */
  partitionKey: CookiePartitionKey | null;
}

export interface SnapshotCookie extends CookieIdentity {
  value: string;
  sameSite: SameSite;
  secure: boolean;
  httpOnly: boolean;
  /** Unix epoch milliseconds. `null` means a session cookie. */
  expires: number | null;
  /** Response generation that produced this state. */
  generation: number;
}

/**
 * A retained deletion. Tombstones are intentionally part of exported
 * snapshots so merging an older snapshot cannot revive the cookie.
 */
export interface CookieTombstone extends CookieIdentity {
  deleted: true;
  generation: number;
  reason: DeletionReason;
}

export type CookiePartitionKeyInput =
  | string
  | null
  | {
      topLevelSite?: string | null;
      hasCrossSiteAncestor?: boolean | null;
      [key: string]: unknown;
    };

/**
 * Loose snapshot entry accepted on import. Chrome-style fields
 * (`expirationDate`, `sameSite: "no_restriction"`, and so on) are supported.
 */
export interface CookieRecordInput {
  name: string;
  value?: string | null;
  domain: string;
  path?: string | null;
  sameSite?: string | null;
  secure?: boolean | null;
  httpOnly?: boolean | null;
  hostOnly?: boolean | null;
  partitionKey?: CookiePartitionKeyInput;
  /** Epoch milliseconds (or epoch seconds when the value is clearly seconds). */
  expires?: number | string | Date | null;
  /** Chrome cookie API field, expressed in epoch seconds. */
  expirationDate?: number | string | Date | null;
  /** Convenience alias for `expires`. */
  expiry?: number | string | Date | null;
  session?: boolean | null;
  generation?: number | string | null;
  responseGeneration?: number | string | null;
  deleted?: boolean | null;
  reason?: DeletionReason | null;
  /** Browser-specific fields (for example `storeId`) are ignored on import. */
  [key: string]: unknown;
}

export interface CookieSnapshotInput {
  format?: string;
  version?: number | string;
  exportedAt?: number | string | Date | null;
  topLevelSite?: string | null;
  generation?: number | string | null;
  cookies?: readonly CookieRecordInput[] | null;
  tombstones?: readonly CookieRecordInput[] | null;
  [key: string]: unknown;
}

export type CookieSnapshotLike =
  | CookieSnapshotInput
  | readonly CookieRecordInput[]
  | string;

export interface CookieSnapshot {
  format: CookieSnapshotFormat;
  /** Unix epoch milliseconds. */
  exportedAt: number;
  topLevelSite: string | null;
  generation: number;
  cookies: SnapshotCookie[];
  tombstones: CookieTombstone[];
}

export interface ImportSnapshotOptions {
  /**
   * Target top-level site. If omitted, the snapshot's own `topLevelSite` is
   * used. Import fails when neither is available.
   */
  topLevelSite?: string;
  now?: number;
  /** Generation used for records that do not carry their own generation. */
  generation?: number | string;
  /** Defaults to `true`. Disabling this gives up deletion resurrection safety. */
  includeTombstones?: boolean;
}

export type ImportSnapshotOptionsLike = ImportSnapshotOptions | string;

export interface ExportSnapshotOptions {
  now?: number;
  topLevelSite?: string | null;
  /** Defaults to `true`. */
  includeTombstones?: boolean;
}

export interface CookieJarOptions {
  now?: number | (() => number);
}

export interface SetCookieContext {
  /** Monotonically increasing response generation; larger is newer. */
  generation: number | string;
  /** Top-level site of the document that received the response. */
  topLevelSite?: string;
  /** Used for default Domain/Path and Domain validation. */
  requestUrl?: string | URL;
  now?: number;
  hasCrossSiteAncestor?: boolean;
  /**
   * Explicit CHIPS partition key. Normally derived from `topLevelSite` when
   * the header contains `Partitioned`.
   */
  partitionKey?: CookiePartitionKeyInput;
  /** Optional tie-breaker for multiple headers with the same generation. */
  sequence?: number;
}

export interface SetCookieEvent extends SetCookieContext {
  header?: string;
  /** Alias for `header`. */
  setCookie?: string;
}

export interface ParsedSetCookie {
  name: string;
  value: string;
  domain: string | null;
  path: string | null;
  /** Effective expiry in epoch milliseconds after Max-Age takes precedence. */
  expires: number | null;
  /** Raw Max-Age value in seconds. */
  maxAge: number | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
  partitioned: boolean;
  deleted: boolean;
}

export interface ReadCookiesOptions {
  topLevelSite?: string;
  now?: number;
}

export interface MergeSetCookieOptions {
  now?: number;
  /** Metadata/filter used for the exported snapshot. */
  topLevelSite?: string;
  includeTombstones?: boolean;
}

interface StoredCookie {
  identity: CookieIdentity;
  value: string;
  sameSite: SameSite;
  secure: boolean;
  httpOnly: boolean;
  expires: number | null;
  generation: number;
  deleted: boolean;
  reason: DeletionReason | null;
  sequence?: number;
}

interface SnapshotData {
  cookies: readonly CookieRecordInput[];
  tombstones: readonly CookieRecordInput[];
  topLevelSite: string | null;
  generation: number | null;
  exportedAt: number | null;
}

interface NormalizedRecordOptions {
  generation: number;
  now: number;
  tombstone?: boolean;
}

const DEFAULT_GENERATION = 0;
const SECONDS_THRESHOLD = 100_000_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeGeneration(
  value: unknown,
  fallback: number = DEFAULT_GENERATION,
): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new CookieSnapshotError(`Invalid cookie generation: ${value}`);
    }
    return parsed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new CookieSnapshotError(`Invalid cookie generation: ${String(value)}`);
}

function normalizeEpochMs(
  value: unknown,
  unit: "auto" | "seconds",
  field: string,
): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
      value = Number(trimmed);
    } else {
      const parsed = Date.parse(trimmed);
      return Number.isNaN(parsed) ? null : parsed;
    }
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CookieSnapshotError(`Invalid ${field}: ${String(value)}`);
  }

  if (
    unit === "seconds" ||
    (Math.abs(value) > 0 && Math.abs(value) < SECONDS_THRESHOLD)
  ) {
    return value * 1000;
  }
  return value;
}

function resolveExpiry(record: CookieRecordInput): number | null {
  if (record.session === true) {
    return null;
  }
  if (record.expirationDate !== undefined && record.expirationDate !== null) {
    return normalizeEpochMs(record.expirationDate, "seconds", "expirationDate");
  }
  if (record.expires !== undefined && record.expires !== null) {
    return normalizeEpochMs(record.expires, "auto", "expires");
  }
  if (record.expiry !== undefined && record.expiry !== null) {
    return normalizeEpochMs(record.expiry, "auto", "expiry");
  }
  return null;
}

function normalizeSameSite(value: unknown): SameSite {
  if (value === undefined || value === null || value === "") {
    return "Lax";
  }
  if (typeof value !== "string") {
    throw new CookieSnapshotError(`Invalid SameSite value: ${String(value)}`);
  }
  switch (value.trim().toLowerCase()) {
    case "strict":
      return "Strict";
    case "lax":
    case "unspecified":
    case "default":
      return "Lax";
    case "none":
    case "no_restriction":
    case "no-restriction":
      return "None";
    default:
      throw new CookieSnapshotError(`Invalid SameSite value: ${value}`);
  }
}

/**
 * Normalizes a schemeful site for comparison.
 *
 * Ports, paths, queries, fragments and a trailing host dot are ignored. Bare
 * hosts are treated as HTTPS because browser partition keys are normally
 * serialized that way.
 */
export function normalizeTopLevelSite(site: string): string {
  if (typeof site !== "string") {
    throw new CookieSnapshotError("topLevelSite must be a string");
  }
  let raw = site.trim();
  if (!raw) {
    throw new CookieSnapshotError("topLevelSite must not be empty");
  }
  if (raw.startsWith("//")) {
    raw = `https:${raw}`;
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CookieSnapshotError(`Invalid top-level site: ${site}`);
  }

  const protocol = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) {
    throw new CookieSnapshotError(`Invalid top-level site: ${site}`);
  }
  return `${protocol}//${host}`;
}

export function normalizePartitionKey(
  input: CookiePartitionKeyInput | undefined,
): CookiePartitionKey | null {
  if (input === undefined || input === null) {
    return null;
  }
  if (typeof input === "string") {
    if (!input.trim()) {
      throw new CookieSnapshotError(
        "partitionKey must not be empty; use null for an unpartitioned cookie",
      );
    }
    return {
      topLevelSite: normalizeTopLevelSite(input),
      hasCrossSiteAncestor: false,
    };
  }
  if (!isRecord(input)) {
    throw new CookieSnapshotError("Invalid partitionKey");
  }
  const site = input.topLevelSite;
  if (typeof site !== "string" || !site.trim()) {
    throw new CookieSnapshotError(
      "A partitioned cookie must include partitionKey.topLevelSite; refusing to downgrade it",
    );
  }
  return {
    topLevelSite: normalizeTopLevelSite(site),
    hasCrossSiteAncestor: input.hasCrossSiteAncestor === true,
  };
}

function normalizeDomain(
  raw: string,
  hostOnlyInput: unknown,
): {
  domain: string;
  hostOnly: boolean;
} {
  let domain = raw.trim().toLowerCase();
  if (!domain) {
    throw new CookieSnapshotError("Cookie domain must not be empty");
  }
  if (domain.endsWith(".")) {
    domain = domain.slice(0, -1);
  }
  const hostOnly =
    typeof hostOnlyInput === "boolean"
      ? hostOnlyInput
      : !domain.startsWith(".");
  const base = domain.replace(/^\.+/, "");
  if (!base) {
    throw new CookieSnapshotError(`Invalid cookie domain: ${raw}`);
  }
  return {
    domain: hostOnly ? base : `.${base}`,
    hostOnly,
  };
}

function normalizePath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    return "/";
  }
  const path = raw.trim();
  return path.startsWith("/") ? path : "/";
}

function normalizeRecord(
  record: CookieRecordInput,
  options: NormalizedRecordOptions,
): StoredCookie {
  if (!isRecord(record)) {
    throw new CookieSnapshotError("Cookie record must be an object");
  }
  if (typeof record.name !== "string" || !record.name) {
    throw new CookieSnapshotError("Cookie record must include a non-empty name");
  }
  if (typeof record.domain !== "string" || !record.domain.trim()) {
    throw new CookieSnapshotError(
      `Cookie "${record.name}" must include a non-empty domain`,
    );
  }

  const { domain, hostOnly } = normalizeDomain(record.domain, record.hostOnly);
  const partitionKey = normalizePartitionKey(record.partitionKey);
  const generation = normalizeGeneration(
    record.generation ?? record.responseGeneration,
    options.generation,
  );
  const expires = resolveExpiry(record);
  const expired = expires !== null && expires <= options.now;
  const deleted = options.tombstone === true || record.deleted === true || expired;

  return {
    identity: {
      name: record.name,
      domain,
      path: normalizePath(record.path),
      hostOnly,
      partitionKey,
    },
    value: deleted ? "" : (record.value ?? ""),
    sameSite: normalizeSameSite(record.sameSite),
    secure: record.secure === true,
    httpOnly: record.httpOnly === true,
    expires,
    generation,
    deleted,
    reason: deleted
      ? (record.reason ?? (expired ? "expired" : "set-cookie"))
      : null,
  };
}

function identityKey(identity: CookieIdentity): string {
  const partition = identity.partitionKey;
  return JSON.stringify([
    identity.name,
    identity.hostOnly ? 1 : 0,
    identity.domain.replace(/^\./, "").toLowerCase(),
    identity.path,
    partition
      ? [
          normalizeTopLevelSite(partition.topLevelSite),
          partition.hasCrossSiteAncestor ? 1 : 0,
        ]
      : null,
  ]);
}

function shouldReplace(existing: StoredCookie, incoming: StoredCookie): boolean {
  if (incoming.generation > existing.generation) {
    return true;
  }
  if (incoming.generation < existing.generation) {
    return false;
  }

  // A sequence is only assigned by response processing. It disambiguates
  // duplicate headers from one response, but must not let an imported
  // snapshot override a more precise live event at the same generation.
  if (existing.sequence !== undefined && incoming.sequence !== undefined) {
    return incoming.sequence > existing.sequence;
  }
  if (incoming.sequence !== undefined && existing.sequence === undefined) {
    return true;
  }
  if (incoming.sequence === undefined && existing.sequence !== undefined) {
    return false;
  }

  // At an equal generation, deletion wins. This is the key anti-resurrection
  // rule when two snapshots share the same generation or carry no generation.
  if (incoming.deleted) {
    return true;
  }
  if (existing.deleted) {
    return false;
  }
  return true;
}

function isApplicableToSite(
  partitionKey: CookiePartitionKey | null,
  topLevelSite: string,
): boolean {
  if (partitionKey === null) {
    return true;
  }
  return normalizeTopLevelSite(partitionKey.topLevelSite) === topLevelSite;
}

function mergeIntoMap(
  states: Map<string, StoredCookie>,
  incoming: StoredCookie,
): void {
  const key = identityKey(incoming.identity);
  const existing = states.get(key);
  if (!existing || shouldReplace(existing, incoming)) {
    states.set(key, incoming);
  }
}

function extractSnapshotData(input: CookieSnapshotLike): SnapshotData {
  let value: unknown = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch (error) {
      throw new CookieSnapshotError(
        `Invalid cookie snapshot JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (Array.isArray(value)) {
    return {
      cookies: value as readonly CookieRecordInput[],
      tombstones: [],
      topLevelSite: null,
      generation: null,
      exportedAt: null,
    };
  }

  if (!isRecord(value)) {
    throw new CookieSnapshotError("Cookie snapshot must be an object or array");
  }

  const hasCookieShape =
    typeof value.name === "string" && typeof value.domain === "string";
  if (hasCookieShape) {
    return {
      cookies: [value as unknown as CookieRecordInput],
      tombstones: [],
      topLevelSite: null,
      generation: null,
      exportedAt: null,
    };
  }

  const cookiesValue = value.cookies;
  const tombstonesValue = value.tombstones;
  if (
    (cookiesValue !== undefined &&
      cookiesValue !== null &&
      !Array.isArray(cookiesValue)) ||
    (tombstonesValue !== undefined &&
      tombstonesValue !== null &&
      !Array.isArray(tombstonesValue))
  ) {
    throw new CookieSnapshotError(
      "Cookie snapshot cookies/tombstones must be arrays",
    );
  }

  const topLevelSite =
    typeof value.topLevelSite === "string" && value.topLevelSite.trim()
      ? normalizeTopLevelSite(value.topLevelSite)
      : null;
  const generation =
    value.generation === undefined || value.generation === null
      ? null
      : normalizeGeneration(value.generation);
  const exportedAt =
    value.exportedAt === undefined || value.exportedAt === null
      ? null
      : normalizeEpochMs(value.exportedAt, "auto", "exportedAt");

  return {
    cookies: (cookiesValue ?? []) as readonly CookieRecordInput[],
    tombstones: (tombstonesValue ?? []) as readonly CookieRecordInput[],
    topLevelSite,
    generation,
    exportedAt,
  };
}

function normalizeSnapshotRecords(
  data: SnapshotData,
  topLevelSite: string,
  now: number,
  generationOverride?: number | string,
): StoredCookie[] {
  const fallbackGeneration =
    generationOverride === undefined
      ? (data.generation ?? DEFAULT_GENERATION)
      : normalizeGeneration(generationOverride);
  const records: StoredCookie[] = [];

  for (const record of data.cookies) {
    const normalized = normalizeRecord(record, {
      generation: fallbackGeneration,
      now,
    });
    if (isApplicableToSite(normalized.identity.partitionKey, topLevelSite)) {
      records.push(normalized);
    }
  }

  for (const record of data.tombstones) {
    const normalized = normalizeRecord(record, {
      generation: fallbackGeneration,
      now,
      tombstone: true,
    });
    if (isApplicableToSite(normalized.identity.partitionKey, topLevelSite)) {
      records.push(normalized);
    }
  }

  return records;
}

function snapshotCookieFromState(state: StoredCookie): SnapshotCookie {
  return {
    ...state.identity,
    partitionKey: state.identity.partitionKey
      ? { ...state.identity.partitionKey }
      : null,
    value: state.value,
    sameSite: state.sameSite,
    secure: state.secure,
    httpOnly: state.httpOnly,
    expires: state.expires,
    generation: state.generation,
  };
}

function tombstoneFromState(state: StoredCookie): CookieTombstone {
  return {
    ...state.identity,
    partitionKey: state.identity.partitionKey
      ? { ...state.identity.partitionKey }
      : null,
    deleted: true,
    generation: state.generation,
    reason: state.reason ?? "set-cookie",
  };
}

function compareIdentity(a: CookieIdentity, b: CookieIdentity): number {
  const fields = [
    a.domain,
    a.path,
    a.name,
    a.partitionKey?.topLevelSite ?? "",
    a.partitionKey?.hasCrossSiteAncestor ? "1" : "0",
  ];
  const other = [
    b.domain,
    b.path,
    b.name,
    b.partitionKey?.topLevelSite ?? "",
    b.partitionKey?.hasCrossSiteAncestor ? "1" : "0",
  ];
  for (let index = 0; index < fields.length; index += 1) {
    if (fields[index] < other[index]) return -1;
    if (fields[index] > other[index]) return 1;
  }
  return 0;
}

function snapshotFromStates(
  states: Iterable<StoredCookie>,
  options: {
    exportedAt: number;
    topLevelSite: string | null;
    includeTombstones: boolean;
  },
): CookieSnapshot {
  const cookies: SnapshotCookie[] = [];
  const tombstones: CookieTombstone[] = [];
  let generation = Number.NEGATIVE_INFINITY;

  for (const state of states) {
    generation = Math.max(generation, state.generation);
    if (state.deleted) {
      if (options.includeTombstones) {
        tombstones.push(tombstoneFromState(state));
      }
    } else {
      cookies.push(snapshotCookieFromState(state));
    }
  }

  cookies.sort(compareIdentity);
  tombstones.sort(compareIdentity);

  return {
    format: COOKIE_SNAPSHOT_FORMAT,
    exportedAt: options.exportedAt,
    topLevelSite: options.topLevelSite,
    generation:
      generation === Number.NEGATIVE_INFINITY
        ? DEFAULT_GENERATION
        : generation,
    cookies,
    tombstones,
  };
}

function normalizeImportOptions(
  options: ImportSnapshotOptionsLike | undefined,
): ImportSnapshotOptions {
  if (options === undefined) {
    return {};
  }
  if (typeof options === "string") {
    return { topLevelSite: options };
  }
  return options;
}

/**
 * Filters a snapshot to the cookies that may be installed under a given
 * top-level site.
 *
 * Unpartitioned cookies are global and therefore retained. A partitioned
 * cookie is retained only when its partition key matches; a mismatch is
 * skipped, never rewritten without its key.
 */
export function filterSnapshotForTopLevelSite(
  snapshot: CookieSnapshotLike,
  topLevelSite: string,
  options: { now?: number } = {},
): CookieSnapshot {
  const target = normalizeTopLevelSite(topLevelSite);
  const data = extractSnapshotData(snapshot);
  const now = options.now ?? Date.now();
  const records = normalizeSnapshotRecords(data, target, now);
  const states = new Map<string, StoredCookie>();
  for (const record of records) {
    mergeIntoMap(states, record);
  }
  return snapshotFromStates(states.values(), {
    exportedAt: data.exportedAt ?? now,
    topLevelSite: target,
    includeTombstones: true,
  });
}

/** Alias kept for callers that use the shorter name. */
export const filterSnapshotByTopLevelSite = filterSnapshotForTopLevelSite;

/**
 * Parses and normalizes a snapshot without importing it into any site.
 * Useful for validation and for inspecting a connector's export.
 */
export function parseCookieSnapshot(
  snapshot: CookieSnapshotLike,
  options: { now?: number } = {},
): CookieSnapshot {
  const data = extractSnapshotData(snapshot);
  const now = options.now ?? Date.now();
  const records: StoredCookie[] = [];
  const generation = data.generation ?? DEFAULT_GENERATION;

  for (const record of data.cookies) {
    records.push(normalizeRecord(record, { generation, now }));
  }
  for (const record of data.tombstones) {
    records.push(normalizeRecord(record, { generation, now, tombstone: true }));
  }

  const states = new Map<string, StoredCookie>();
  for (const record of records) {
    mergeIntoMap(states, record);
  }

  return snapshotFromStates(states.values(), {
    exportedAt: data.exportedAt ?? now,
    topLevelSite: data.topLevelSite,
    includeTombstones: true,
  });
}

/**
 * Merges snapshots according to response generation.
 *
 * Every input is filtered by the target top-level site before its records are
 * merged. Tombstones survive the export so a later import of an older
 * snapshot cannot recreate a deleted cookie.
 */
export function mergeSnapshots(
  snapshots: readonly CookieSnapshotLike[],
  options?: ImportSnapshotOptionsLike,
): CookieSnapshot {
  const normalizedOptions = normalizeImportOptions(options);
  const targetValue =
    normalizedOptions.topLevelSite ??
    snapshots
      .map((snapshot) => extractSnapshotData(snapshot))
      .find((data) => data.topLevelSite !== null)?.topLevelSite;
  if (!targetValue) {
    throw new CookieSnapshotError(
      "A target topLevelSite is required before importing a cookie snapshot",
    );
  }
  const target = normalizeTopLevelSite(targetValue);
  const now = normalizedOptions.now ?? Date.now();
  const jar = new CookieJar({ now });

  for (const snapshot of snapshots) {
    jar.import(snapshot, {
      topLevelSite: target,
      now,
      generation: normalizedOptions.generation,
      includeTombstones: normalizedOptions.includeTombstones,
    });
  }

  return jar.toSnapshot({
    now,
    topLevelSite: target,
    includeTombstones: normalizedOptions.includeTombstones !== false,
  });
}

export function importSnapshot(
  snapshot: CookieSnapshotLike,
  options?: ImportSnapshotOptionsLike,
): CookieSnapshot {
  return mergeSnapshots([snapshot], options);
}

export const importCookieSnapshot = importSnapshot;

function splitCookieParts(header: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;

  for (const character of header) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quoted) {
      current += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      current += character;
      continue;
    }
    if (character === ";" && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

function unquoteCookieValue(value: string): string {
  if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') {
    return value;
  }
  let result = "";
  const inner = value.slice(1, -1);
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (character === "\\" && index + 1 < inner.length) {
      index += 1;
      result += inner[index];
    } else {
      result += character;
    }
  }
  return result;
}

/** Parses a single Set-Cookie header. */
export function parseSetCookie(
  header: string,
  options: { now?: number } = {},
): ParsedSetCookie {
  if (typeof header !== "string" || !header.trim()) {
    throw new CookieSnapshotError("Set-Cookie header must not be empty");
  }
  const now = options.now ?? Date.now();
  const parts = splitCookieParts(header);
  const pair = parts.shift() ?? "";
  const equals = pair.indexOf("=");
  if (equals <= 0) {
    throw new CookieSnapshotError(`Invalid Set-Cookie header: ${header}`);
  }

  const name = pair.slice(0, equals).trim();
  if (!name) {
    throw new CookieSnapshotError(`Invalid Set-Cookie name: ${header}`);
  }
  const value = unquoteCookieValue(pair.slice(equals + 1).trim());

  let domain: string | null = null;
  let path: string | null = null;
  let expiresAt: number | null = null;
  let maxAge: number | null = null;
  let secure = false;
  let httpOnly = false;
  let partitioned = false;
  let sameSite: SameSite = "Lax";

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    const attributeName = (
      separator === -1 ? trimmed : trimmed.slice(0, separator)
    )
      .trim()
      .toLowerCase();
    const attributeValue =
      separator === -1 ? "" : trimmed.slice(separator + 1).trim();

    switch (attributeName) {
      case "domain":
        if (attributeValue) domain = attributeValue;
        break;
      case "path":
        if (attributeValue) path = attributeValue;
        break;
      case "expires": {
        const parsed = Date.parse(attributeValue);
        if (!Number.isNaN(parsed)) expiresAt = parsed;
        break;
      }
      case "max-age": {
        if (/^[+-]?\d+$/.test(attributeValue)) {
          const parsed = Number(attributeValue);
          if (Number.isSafeInteger(parsed)) maxAge = parsed;
        }
        break;
      }
      case "secure":
        secure = true;
        break;
      case "httponly":
        httpOnly = true;
        break;
      case "samesite":
        sameSite = normalizeSameSite(attributeValue);
        break;
      case "partitioned":
        partitioned = true;
        break;
      default:
        break;
    }
  }

  const expires = maxAge !== null ? now + maxAge * 1000 : expiresAt;
  const deleted =
    (maxAge !== null && maxAge <= 0) || (expires !== null && expires <= now);

  return {
    name,
    value,
    domain,
    path,
    expires,
    maxAge,
    secure,
    httpOnly,
    sameSite,
    partitioned,
    deleted,
  };
}

function domainMatches(host: string, domain: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/\.$/, "");
  const normalizedDomain = domain
    .toLowerCase()
    .replace(/^\./, "")
    .replace(/\.$/, "");
  if (!normalizedHost || !normalizedDomain) {
    return false;
  }
  return (
    normalizedHost === normalizedDomain ||
    normalizedHost.endsWith(`.${normalizedDomain}`)
  );
}

function defaultPath(request: URL | null): string {
  if (!request) return "/";
  const pathname = request.pathname;
  if (!pathname || !pathname.startsWith("/")) return "/";
  const slash = pathname.lastIndexOf("/");
  return slash <= 0 ? "/" : pathname.slice(0, slash);
}

function requestUrlFrom(value: string | URL | undefined): URL | null {
  if (value === undefined) return null;
  if (value instanceof URL) return value;
  try {
    return new URL(value);
  } catch {
    throw new CookieSnapshotError(`Invalid request URL: ${value}`);
  }
}

/**
 * A stateful cookie jar. Imports are site-filtered, and Set-Cookie headers are
 * merged by response generation.
 */
export class CookieJar {
  private readonly states = new Map<string, StoredCookie>();
  private readonly clock: () => number;
  private sequence = 0;
  private lastTopLevelSite: string | null = null;

  constructor(options: CookieJarOptions = {}) {
    if (typeof options.now === "function") {
      this.clock = options.now;
    } else if (typeof options.now === "number") {
      const fixed = options.now;
      this.clock = () => fixed;
    } else {
      this.clock = () => Date.now();
    }
  }

  get size(): number {
    this.expireStates(this.clock());
    let count = 0;
    for (const state of this.states.values()) {
      if (!state.deleted) count += 1;
    }
    return count;
  }

  import(
    snapshot: CookieSnapshotLike,
    options: ImportSnapshotOptionsLike = {},
  ): this {
    const normalizedOptions = normalizeImportOptions(options);
    const data = extractSnapshotData(snapshot);
    const targetValue = normalizedOptions.topLevelSite ?? data.topLevelSite;
    if (!targetValue) {
      throw new CookieSnapshotError(
        "A target topLevelSite is required before importing a cookie snapshot",
      );
    }
    const target = normalizeTopLevelSite(targetValue);
    const now = normalizedOptions.now ?? this.clock();
    const records = normalizeSnapshotRecords(
      data,
      target,
      now,
      normalizedOptions.generation,
    );
    for (const record of records) {
      this.mergeStored(record);
    }
    this.lastTopLevelSite = target;
    return this;
  }

  importSnapshot(
    snapshot: CookieSnapshotLike,
    options: ImportSnapshotOptionsLike = {},
  ): this {
    return this.import(snapshot, options);
  }

  applySetCookie(header: string, context: SetCookieContext): this {
    const now = context.now ?? this.clock();
    const sequence = context.sequence ?? this.nextSequence();
    if (context.sequence !== undefined) {
      this.sequence = Math.max(this.sequence, context.sequence);
    }
    this.applySetCookieInternal(header, context, sequence, now);
    return this;
  }

  applySetCookies(headers: readonly string[], context: SetCookieContext): this {
    const now = context.now ?? this.clock();
    if (context.sequence === undefined) {
      for (const header of headers) {
        this.applySetCookieInternal(header, context, this.nextSequence(), now);
      }
    } else {
      let sequence = context.sequence;
      for (const header of headers) {
        this.applySetCookieInternal(header, context, sequence, now);
        sequence += 1;
      }
      this.sequence = Math.max(this.sequence, sequence - 1);
    }
    return this;
  }

  applyResponse(headers: readonly string[], context: SetCookieContext): this {
    return this.applySetCookies(headers, context);
  }

  getCookies(options: ReadCookiesOptions = {}): SnapshotCookie[] {
    const now = options.now ?? this.clock();
    this.expireStates(now);
    const target =
      options.topLevelSite === undefined
        ? null
        : normalizeTopLevelSite(options.topLevelSite);
    const result: SnapshotCookie[] = [];
    for (const state of this.states.values()) {
      if (state.deleted) continue;
      if (
        target !== null &&
        !isApplicableToSite(state.identity.partitionKey, target)
      ) {
        continue;
      }
      result.push(snapshotCookieFromState(state));
    }
    result.sort(compareIdentity);
    return result;
  }

  getCookie(
    name: string,
    options: ReadCookiesOptions = {},
  ): SnapshotCookie | null {
    return (
      this.getCookies(options).find((cookie) => cookie.name === name) ?? null
    );
  }

  toSnapshot(options: ExportSnapshotOptions = {}): CookieSnapshot {
    const now = options.now ?? this.clock();
    this.expireStates(now);
    const target =
      options.topLevelSite === undefined
        ? this.lastTopLevelSite
        : options.topLevelSite === null
          ? null
          : normalizeTopLevelSite(options.topLevelSite);
    const states =
      target === null
        ? this.states.values()
        : [...this.states.values()].filter((state) =>
            isApplicableToSite(state.identity.partitionKey, target),
          );

    return snapshotFromStates(states, {
      exportedAt: now,
      topLevelSite: target,
      includeTombstones: options.includeTombstones !== false,
    });
  }

  export(options: ExportSnapshotOptions = {}): CookieSnapshot {
    return this.toSnapshot(options);
  }

  clear(): this {
    this.states.clear();
    this.lastTopLevelSite = null;
    return this;
  }

  private mergeStored(incoming: StoredCookie): void {
    mergeIntoMap(this.states, incoming);
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private expireStates(now: number): void {
    for (const [key, state] of this.states) {
      if (!state.deleted && state.expires !== null && state.expires <= now) {
        this.states.set(key, {
          ...state,
          value: "",
          deleted: true,
          reason: "expired",
        });
      }
    }
  }

  private applySetCookieInternal(
    header: string,
    context: SetCookieContext,
    sequence: number,
    now: number,
  ): void {
    const parsed = parseSetCookie(header, { now });
    const request = requestUrlFrom(context.requestUrl);

    let hostOnly: boolean;
    let domain: string;
    if (parsed.domain !== null) {
      if (request && !domainMatches(request.hostname, parsed.domain)) {
        throw new CookieSnapshotError(
          `Cookie domain ${parsed.domain} does not match request host ${request.hostname}`,
        );
      }
      const normalized = normalizeDomain(parsed.domain, false);
      domain = normalized.domain;
      hostOnly = normalized.hostOnly;
    } else {
      if (!request) {
        throw new CookieSnapshotError(
          "requestUrl is required when a Set-Cookie header has no Domain attribute",
        );
      }
      const normalized = normalizeDomain(request.hostname, true);
      domain = normalized.domain;
      hostOnly = normalized.hostOnly;
    }

    const path =
      parsed.path !== null && parsed.path.startsWith("/")
        ? parsed.path
        : defaultPath(request);

    let partitionKey: CookiePartitionKey | null = null;
    if (context.partitionKey !== undefined) {
      partitionKey = normalizePartitionKey(context.partitionKey);
      if (partitionKey === null && parsed.partitioned) {
        throw new CookieSnapshotError(
          "A Partitioned Set-Cookie header cannot have a null partition key",
        );
      }
    } else if (parsed.partitioned) {
      if (!context.topLevelSite) {
        throw new CookieSnapshotError(
          "A Partitioned Set-Cookie header requires topLevelSite; refusing to downgrade it",
        );
      }
      partitionKey = {
        topLevelSite: normalizeTopLevelSite(context.topLevelSite),
        hasCrossSiteAncestor: context.hasCrossSiteAncestor === true,
      };
    }

    if (context.topLevelSite) {
      this.lastTopLevelSite = normalizeTopLevelSite(context.topLevelSite);
    }

    const stored: StoredCookie = {
      identity: {
        name: parsed.name,
        domain,
        path,
        hostOnly,
        partitionKey,
      },
      value: parsed.deleted ? "" : parsed.value,
      sameSite: parsed.sameSite,
      secure: parsed.secure,
      httpOnly: parsed.httpOnly,
      expires: parsed.expires,
      generation: normalizeGeneration(context.generation),
      deleted: parsed.deleted,
      reason: parsed.deleted ? "set-cookie" : null,
      sequence,
    };
    this.mergeStored(stored);
  }
}

/** Stateless helper for a single Set-Cookie header. */
export function applySetCookie(
  header: string,
  context: SetCookieContext,
): CookieSnapshot {
  const jar = new CookieJar({ now: context.now });
  jar.applySetCookie(header, context);
  return jar.toSnapshot({
    now: context.now,
    topLevelSite: context.topLevelSite ?? null,
  });
}

/** Stateless helper for all Set-Cookie headers from one response. */
export function applySetCookies(
  headers: readonly string[],
  context: SetCookieContext,
): CookieSnapshot {
  const jar = new CookieJar({ now: context.now });
  jar.applySetCookies(headers, context);
  return jar.toSnapshot({
    now: context.now,
    topLevelSite: context.topLevelSite ?? null,
  });
}

/**
 * Merges concurrent response Set-Cookie events by generation. Event order is
 * irrelevant for conflicting cookies when generations differ.
 */
export function mergeSetCookieEvents(
  events: readonly SetCookieEvent[],
  options: MergeSetCookieOptions = {},
): CookieSnapshot {
  const jar = new CookieJar({ now: options.now });
  for (const event of events) {
    const header = event.header ?? event.setCookie;
    if (!header) {
      throw new CookieSnapshotError(
        "Each Set-Cookie event must include header or setCookie",
      );
    }
    jar.applySetCookie(header, {
      generation: event.generation,
      topLevelSite: event.topLevelSite,
      requestUrl: event.requestUrl,
      now: event.now ?? options.now,
      hasCrossSiteAncestor: event.hasCrossSiteAncestor,
      partitionKey: event.partitionKey,
      sequence: event.sequence,
    });
  }
  return jar.toSnapshot({
    now: options.now,
    topLevelSite: options.topLevelSite ?? null,
    includeTombstones: options.includeTombstones !== false,
  });
}

export const mergeCookieSnapshots = mergeSnapshots;
export const mergeSetCookies = mergeSetCookieEvents;

export default {
  COOKIE_SNAPSHOT_FORMAT,
  CookieJar,
  CookieSnapshotError,
  applySetCookie,
  applySetCookies,
  filterSnapshotByTopLevelSite,
  filterSnapshotForTopLevelSite,
  importCookieSnapshot,
  importSnapshot,
  mergeCookieSnapshots,
  mergeSetCookieEvents,
  mergeSetCookies,
  mergeSnapshots,
  normalizePartitionKey,
  normalizeTopLevelSite,
  parseCookieSnapshot,
  parseSetCookie,
};
