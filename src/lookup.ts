import type {
  ChangeStreamEvent,
  Document,
  FullDocumentLookupEvidence,
  FullDocumentResolveOptions,
  LookupContext,
  LookupSource,
  Namespace,
} from "./types.ts";
import {
  compareVersionValues,
  extractDocumentVersion,
  normalizeNamespace,
  normalizeTimestampMs,
  normalizeVersionNumber,
  resumeTokenOf,
} from "./utils.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function invokeLookup(
  source: LookupSource,
  context: LookupContext,
): Promise<Document | null> {
  if (source == null) return null;
  if (typeof source === "function") {
    return (await source(context)) ?? null;
  }
  if (typeof source === "object" && typeof source.findOne === "function") {
    const filter = context.documentKey ?? {};
    return (
      (await source.findOne(filter, {
        event: context.event,
        namespace: context.namespace,
        eventTime: context.eventTime,
        readTime: context.readTime,
      })) ?? null
    );
  }
  if (isRecord(source)) {
    // A pre-fetched document is accepted as a convenience.
    return source;
  }
  return null;
}

function inferNewer(
  comparison: "newer" | "same" | "older" | "unknown",
  readVersionComparable: number | null,
  eventTimeMs: number | null,
): boolean {
  if (comparison === "newer") return true;
  if (comparison !== "unknown") return false;
  if (readVersionComparable === null || eventTimeMs === null) return false;
  return readVersionComparable > eventTimeMs;
}

/**
 * Resolve `fullDocument` for an event and preserve both evidence points:
 *
 * - event time: the operation's `clusterTime`/`wallTime` (and the event's
 *   embedded `fullDocument`, when present);
 * - read time: the instant at which the lookup is issued (and the looked-up
 *   document).
 *
 * A lookup can race with newer writes. When the looked-up document has a
 * newer version than the event, the newer document is selected for output,
 * but the event-time document/version/time are never discarded.
 */
export async function resolveFullDocument(
  event: ChangeStreamEvent,
  lookup: LookupSource,
  options: FullDocumentResolveOptions = {},
): Promise<FullDocumentLookupEvidence> {
  if (options.requireLookup && lookup == null) {
    throw new Error(
      "fullDocument lookup was required but no lookup source was supplied",
    );
  }

  const readTime = new Date(
    (options.readTime ?? options.clock?.() ?? new Date()).getTime(),
  );
  if (!Number.isFinite(readTime.getTime())) {
    throw new RangeError("readTime must be a valid Date");
  }

  const eventTime = event.clusterTime ?? event.wallTime ?? null;
  const eventTimeMs = normalizeTimestampMs(eventTime);
  const wallTime = event.wallTime ?? null;
  const wallTimeMs = normalizeTimestampMs(wallTime);
  const eventDocument = event.fullDocument ?? null;
  const namespace: Namespace | null =
    options.namespace ?? normalizeNamespace(event.ns);
  const documentKey = event.documentKey ?? null;

  let readDocument: Document | null = null;
  if (lookup != null) {
    const context: LookupContext = {
      event,
      namespace,
      documentKey,
      eventTime,
      readTime,
      resumeToken: resumeTokenOf(event),
    };
    const result = await invokeLookup(lookup, context);
    readDocument = isRecord(result) ? result : null;
  }

  const eventVersion = extractDocumentVersion(eventDocument, options.versionOf);
  const readVersion = extractDocumentVersion(readDocument, options.versionOf);
  const versionComparison = compareVersionValues(readVersion, eventVersion);
  const eventVersionComparable = normalizeVersionNumber(eventVersion);
  const readVersionComparable = normalizeVersionNumber(readVersion);
  const newerThanEvent = inferNewer(
    versionComparison.comparison,
    readVersionComparable,
    eventTimeMs,
  );

  let document: Document | null = null;
  let source: FullDocumentLookupEvidence["source"] = "none";
  if (readDocument !== null && eventDocument !== null) {
    if (newerThanEvent) {
      document = readDocument;
      source = "lookup";
    } else {
      document = eventDocument;
      source = "event";
    }
  } else if (readDocument !== null) {
    document = readDocument;
    source = "lookup";
  } else if (eventDocument !== null) {
    document = eventDocument;
    source = "event";
  }

  return {
    document,
    source,
    eventTime,
    eventTimeMs,
    wallTime,
    wallTimeMs,
    readTime,
    readTimeMs: readTime.getTime(),
    readStartedAt: readTime,
    readCompletedAt: readTime,
    eventDocument,
    readDocument,
    documentAtEvent: eventDocument,
    documentAtRead: readDocument,
    eventVersion,
    readVersion,
    eventVersionComparable,
    readVersionComparable,
    newerThanEvent,
    lookupNewer: newerThanEvent,
    stale: newerThanEvent,
    versionComparison: versionComparison.comparison,
    preserved: {
      event: {
        time: eventTime,
        timeMs: eventTimeMs,
        document: eventDocument,
        version: eventVersion,
        versionComparable: eventVersionComparable,
      },
      read: {
        time: readTime,
        timeMs: readTime.getTime(),
        document: readDocument,
        version: readVersion,
        versionComparable: readVersionComparable,
      },
    },
  };
}

export const lookupFullDocument = resolveFullDocument;
