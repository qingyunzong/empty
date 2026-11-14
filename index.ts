/**
 * Deterministic navigation attribution for browser collection pipelines.
 *
 * The tracker binds requests, redirects, same-document navigations, lifecycle
 * events and frame detaches to one document generation. Every generation is
 * immutable with respect to its request tree: a response that belongs to an
 * older generation can never be attached to the generation that replaced it.
 *
 * Events are reduced from a canonical ordering rather than from arrival order.
 * Re-feeding the same events in any order therefore produces the same request
 * tree.
 */

export type NavigationEventKind =
  | "frame-navigated"
  | "frame-detached"
  | "frame-attached"
  | "same-document"
  | "request"
  | "redirect"
  | "response"
  | "request-finished"
  | "request-failed"
  | "lifecycle";

export type GenerationState = "active" | "superseded" | "detached";

/** A loose event shape. It accepts normalized events as well as CDP events. */
export interface NavigationEventInput {
  readonly [key: string]: unknown;
  type?: string;
  kind?: string;
  method?: string;
  params?: Record<string, unknown>;
}

export interface NavigationTrackerOptions {
  /**
   * Create an implicit generation when a request/lifecycle event arrives
   * before its frame navigation. Defaults to `true`.
   */
  autoCreateGenerations?: boolean;
  /** Keep a record of responses that were too late for their generation. */
  recordLateResponses?: boolean;
  /** Use this frame id for events that do not carry one. */
  unknownFrameId?: string;
  /**
   * `auto` uses sequence numbers when every event has one, timestamps when
   * every event has one, and a semantic fallback otherwise.
   */
  ordering?: "auto" | "timestamp" | "sequence" | "arrival";
}

export interface RedirectRecord {
  from: string | null;
  to: string;
  status: number | null;
  statusText: string | null;
  location: string | null;
  timestamp: number | null;
}

export interface ResponseRecord {
  url: string | null;
  status: number | null;
  statusText: string | null;
  mimeType: string | null;
  headers: Record<string, unknown> | null;
  fromDiskCache: boolean | null;
  fromServiceWorker: boolean | null;
  timestamp: number | null;
  loaderId: string | null;
  raw: Record<string, unknown> | null;
}

export interface RequestRecord {
  requestId: string;
  frameId: string;
  generationId: string;
  documentGeneration: string;
  loaderId: string | null;
  url: string;
  originalUrl: string;
  method: string | null;
  resourceType: string | null;
  redirects: RedirectRecord[];
  response: ResponseRecord | null;
  startedAt: number | null;
  respondedAt: number | null;
  finishedAt: number | null;
  /** True when a response was deliberately kept out of the active page. */
  lateResponse: boolean;
  /** True when the owning generation is no longer active. */
  stale: boolean;
  active: boolean;
  finished: boolean;
  failed: boolean;
  failure: string | null;
  canceled: boolean;
}

export interface SameDocumentNavigationRecord {
  url: string;
  timestamp: number | null;
  navigationType: string | null;
  stale: boolean;
}

export interface LifecycleRecord {
  name: string;
  timestamp: number | null;
  loaderId: string | null;
  stale: boolean;
}

export interface DocumentGeneration {
  /** Stable, unique identifier for this document generation. */
  id: string;
  generationId: string;
  documentGeneration: string;
  frameId: string;
  parentFrameId: string | null;
  parentGenerationId: string | null;
  loaderId: string | null;
  url: string;
  currentUrl: string;
  /** Per-frame creation ordinal (the first generation is 1). */
  ordinal: number;
  state: GenerationState;
  active: boolean;
  revoked: boolean;
  revokedAt: number | null;
  revokedReason: string | null;
  implicit: boolean;
  createdAt: number | null;
  requests: RequestRecord[];
  sameDocumentNavigations: SameDocumentNavigationRecord[];
  lifecycleEvents: LifecycleRecord[];
  lifecycle: Record<string, LifecycleRecord>;
  childGenerationIds: string[];
  childFrameIds: string[];
}

export interface FrameState {
  frameId: string;
  parentFrameId: string | null;
  currentGenerationId: string | null;
  detached: boolean;
  generationIds: string[];
}

export interface RequestTreeNode {
  id: string;
  generationId: string;
  documentGeneration: string;
  frameId: string;
  loaderId: string | null;
  url: string;
  parentGenerationId: string | null;
  active: boolean;
  requests: RequestRecord[];
  children: RequestTreeNode[];
}

export interface LateResponseRecord {
  requestId: string;
  frameId: string;
  requestGenerationId: string;
  attachedToGenerationId: string;
  currentGenerationId: string | null;
  status: number | null;
  url: string | null;
  timestamp: number | null;
  reason: string;
}

export interface OrphanResponseRecord {
  requestId: string;
  frameId: string | null;
  loaderId: string | null;
  status: number | null;
  url: string | null;
  timestamp: number | null;
  reason: string;
}

export interface NavigationSnapshot {
  frames: FrameState[];
  generations: DocumentGeneration[];
  /** Active document generations only. */
  activeGenerations: DocumentGeneration[];
  /** Request tree restricted to the current page of each frame. */
  requestTree: RequestTreeNode[];
  /** Alias for `requestTree`. */
  tree: RequestTreeNode[];
  /** Every generation, including superseded and detached ones. */
  fullRequestTree: RequestTreeNode[];
  /** Requests belonging to active generations. */
  requests: RequestRecord[];
  activeRequests: RequestRecord[];
  /** Requests from all generations, useful for audit/debugging. */
  allRequests: RequestRecord[];
  requestsByGeneration: Record<string, RequestRecord[]>;
  lateResponses: LateResponseRecord[];
  orphanResponses: OrphanResponseRecord[];
}

export interface NavigationEventResult {
  accepted: boolean;
  kind: NavigationEventKind | null;
  eventId: number | null;
  generationId: string | null;
  requestId: string | null;
  stale: boolean;
  lateResponse: boolean;
  reason: string | null;
}

interface NormalizedEvent {
  uid: number;
  kind: NavigationEventKind;
  raw: Record<string, unknown>;
  frameId: string | null;
  parentFrameId: string | null;
  loaderId: string | null;
  requestId: string | null;
  url: string | null;
  documentUrl: string | null;
  method: string | null;
  status: number | null;
  statusText: string | null;
  resourceType: string | null;
  timestamp: number | null;
  sequence: number | null;
  lifecycleName: string | null;
  navigationType: string | null;
  generationId: string | null;
  response: Record<string, unknown> | null;
  redirectResponse: Record<string, unknown> | null;
  canonical: string;
}

interface InternalRequest {
  requestId: string;
  frameId: string;
  generationId: string;
  loaderId: string | null;
  url: string;
  originalUrl: string;
  method: string | null;
  resourceType: string | null;
  redirects: RedirectRecord[];
  response: ResponseRecord | null;
  startedAt: number | null;
  respondedAt: number | null;
  finishedAt: number | null;
  lateResponse: boolean;
  finished: boolean;
  failed: boolean;
  failure: string | null;
  canceled: boolean;
  order: number;
}

interface InternalGeneration {
  id: string;
  frameId: string;
  parentFrameId: string | null;
  parentGenerationId: string | null;
  loaderId: string | null;
  url: string;
  currentUrl: string;
  ordinal: number;
  state: GenerationState;
  active: boolean;
  revokedAt: number | null;
  revokedReason: string | null;
  implicit: boolean;
  createdAt: number | null;
  requests: Map<string, InternalRequest>;
  sameDocumentNavigations: SameDocumentNavigationRecord[];
  lifecycleEvents: LifecycleRecord[];
  lifecycle: Map<string, LifecycleRecord>;
}

interface InternalFrame {
  frameId: string;
  parentFrameId: string | null;
  currentGenerationId: string | null;
  detached: boolean;
  generations: InternalGeneration[];
}

const KIND_PRIORITY: Record<NavigationEventKind, number> = {
  "frame-navigated": 10,
  "frame-attached": 15,
  "same-document": 20,
  request: 30,
  redirect: 31,
  response: 40,
  lifecycle: 50,
  "request-finished": 60,
  "request-failed": 65,
  "frame-detached": 90,
};

const KIND_ALIASES: Record<string, NavigationEventKind> = {
  "frame-navigated": "frame-navigated",
  framenavigated: "frame-navigated",
  "frame.navigated": "frame-navigated",
  navigation: "frame-navigated",
  navigate: "frame-navigated",
  "frame-detached": "frame-detached",
  framedetached: "frame-detached",
  "frame-detach": "frame-detached",
  framedetach: "frame-detached",
  "frame.detached": "frame-detached",
  detach: "frame-detached",
  detached: "frame-detached",
  "frame-attached": "frame-attached",
  frameattached: "frame-attached",
  "frame.attached": "frame-attached",
  "same-document": "same-document",
  "same-document-navigation": "same-document",
  samedocumentnavigation: "same-document",
  navigatedwithindocument: "same-document",
  "navigated-within-document": "same-document",
  navigationwithindocument: "same-document",
  "navigation-within-document": "same-document",
  "page.navigatedwithindocument": "same-document",
  request: "request",
  requestwillsent: "request",
  requestwillbesent: "request",
  "request-will-be-sent": "request",
  "network.requestwillsent": "request",
  "network.requestwillbesent": "request",
  redirect: "redirect",
  requestredirect: "redirect",
  "request-redirect": "redirect",
  response: "response",
  responsereceived: "response",
  "response-received": "response",
  "network.responsereceived": "response",
  "request-finished": "request-finished",
  loadingfinished: "request-finished",
  "loading-finished": "request-finished",
  "network.loadingfinished": "request-finished",
  requestfinished: "request-finished",
  finished: "request-finished",
  "request-failed": "request-failed",
  loadingfailed: "request-failed",
  "loading-failed": "request-failed",
  "network.loadingfailed": "request-failed",
  requestfailed: "request-failed",
  failed: "request-failed",
  lifecycle: "lifecycle",
  lifecycleevent: "lifecycle",
  "lifecycle-event": "lifecycle",
  "page.lifecycleevent": "lifecycle",
};

let nextUid = 1;
let nextRequestOrder = 1;

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function parseTimestamp(value: unknown, key?: string): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    if (key === "wallTime" || /^\d{4}-\d\d-\d\dT/.test(value)) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function normalizeKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^page\./, "")
    .replace(/^network\./, "")
    .replace(/[_\s]+/g, "-");
}

function detectKind(envelope: Record<string, unknown>, payload: Record<string, unknown>): NavigationEventKind | null {
  const candidates = [
    envelope.method,
    envelope.type,
    envelope.kind,
    envelope.event,
    envelope.eventType,
    envelope.name,
    payload.type,
    payload.kind,
    payload.event,
    payload.eventType,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const raw = candidate.replace(/^Page\./i, "").replace(/^Network\./i, "");
    const aliases = [raw, normalizeKey(raw), normalizeKey(raw).replace(/-/g, "")];
    for (const alias of aliases) {
      const kind = KIND_ALIASES[alias];
      if (kind) return kind;
    }
  }
  return null;
}

function unwrapEvent(input: NavigationEventInput): {
  envelope: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const envelope = isRecord(input) ? input as Record<string, unknown> : {};
  const params = isRecord(envelope.params) ? envelope.params : null;
  return {
    envelope,
    payload: params ? { ...envelope, ...params } : envelope,
  };
}

function readFrameFields(payload: Record<string, unknown>): {
  frameId: string | null;
  parentFrameId: string | null;
  loaderId: string | null;
  frameUrl: string | null;
} {
  const frame = isRecord(payload.frame) ? payload.frame : null;
  return {
    frameId: firstString(payload.frameId, payload.frame_id, frame?.id),
    parentFrameId: firstString(
      payload.parentFrameId,
      payload.parent_frame_id,
      payload.parentId,
      payload.parent_id,
      frame?.parentId,
      frame?.parent_id,
    ),
    loaderId: firstString(payload.loaderId, payload.loader_id, frame?.loaderId, frame?.loader_id),
    frameUrl: firstString(frame?.url, frame?.documentURL, frame?.documentUrl),
  };
}

function readRequestFields(payload: Record<string, unknown>): {
  requestId: string | null;
  requestUrl: string | null;
  method: string | null;
  resourceType: string | null;
  documentUrl: string | null;
} {
  const request = isRecord(payload.request) ? payload.request : null;
  const envelopeMethod =
    typeof payload.method === "string" && (payload.method.includes(".") || KIND_ALIASES[normalizeKey(payload.method)])
      ? null
      : firstString(payload.method);
  const payloadResourceType =
    typeof payload.type === "string" &&
    !payload.type.includes(".") &&
    !KIND_ALIASES[normalizeKey(payload.type)] &&
    !KIND_ALIASES[normalizeKey(payload.type).replace(/-/g, "")]
      ? payload.type
      : null;
  return {
    requestId: firstString(
      payload.requestId,
      payload.request_id,
      request?.id,
      payload.fromRequestId,
      payload.from_request_id,
      payload.redirectedFrom,
      payload.redirected_from,
    ),
    requestUrl: firstString(request?.url, payload.url, payload.requestUrl, payload.request_url),
    method: firstString(request?.method, payload.requestMethod, payload.request_method, payload.httpMethod, envelopeMethod),
    resourceType: firstString(request?.type, payload.resourceType, payload.resource_type, payloadResourceType),
    documentUrl: firstString(
      payload.documentURL,
      payload.documentUrl,
      payload.document_url,
      request?.documentURL,
      request?.documentUrl,
    ),
  };
}

function cloneRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? { ...value } : null;
}

function headerValue(headers: unknown, name: string): string | null {
  if (!isRecord(headers)) return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return firstString(value);
  }
  return null;
}

function stableStringify(value: unknown, seen = new Set<unknown>()): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const type = typeof value;
  if (type === "number" || type === "boolean") return String(value);
  if (type === "string") return JSON.stringify(value);
  if (type !== "object") return JSON.stringify(String(value));
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((entry) => stableStringify(entry, seen)).join(",")}]`;
  } else {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    result = `{${keys
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key], seen)}`)
      .join(",")}}`;
  }
  seen.delete(value);
  return result;
}

function normalizeEvent(input: NavigationEventInput, forcedKind?: NavigationEventKind | null): NormalizedEvent | null {
  const { envelope, payload } = unwrapEvent(input);
  const detected = detectKind(envelope, payload);
  let kind = forcedKind ?? detected;

  const frame = readFrameFields(payload);
  const request = readRequestFields(payload);
  const response = cloneRecord(payload.response);
  const redirectResponse = cloneRecord(payload.redirectResponse ?? payload.redirect_response);

  if (kind === "request" && detected === "redirect") kind = "redirect";
  if (kind === "request" && redirectResponse) kind = "redirect";
  if (!kind) return null;

  const url =
    kind === "response"
      ? firstString(response?.url, payload.url, request.requestUrl, request.documentUrl)
      : kind === "frame-navigated" || kind === "same-document"
        ? firstString(
            payload.url,
            payload.newUrl,
            payload.new_url,
            frame.frameUrl,
            payload.documentURL,
            payload.documentUrl,
          )
        : firstString(
            request.requestUrl,
            payload.toUrl,
            payload.to_url,
            payload.newUrl,
            payload.new_url,
            payload.to,
            payload.redirectUrl,
            payload.redirect_url,
            payload.url,
            redirectResponse?.url,
            frame.frameUrl,
            request.documentUrl,
          );

  const timestamp =
    parseTimestamp(payload.timestamp, "timestamp") ??
    parseTimestamp(payload.time, "time") ??
    parseTimestamp(payload.ts, "ts") ??
    parseTimestamp(payload.at, "at") ??
    parseTimestamp(payload.monotonicTime, "monotonicTime") ??
    parseTimestamp(payload.wallTime, "wallTime");

  const sequence = firstNumber(
    envelope.seq,
    envelope.sequence,
    envelope.eventSequence,
    envelope.order,
    payload.seq,
    payload.sequence,
    payload.eventSequence,
    payload.order,
  );

  const canonicalPayload: Record<string, unknown> = { ...payload };
  delete canonicalPayload.seq;
  delete canonicalPayload.sequence;
  delete canonicalPayload.eventSequence;
  delete canonicalPayload.order;
  const canonical = `${kind}|${stableStringify(canonicalPayload)}`;

  return {
    uid: nextUid++,
    kind,
    raw: payload,
    frameId: frame.frameId,
    parentFrameId: frame.parentFrameId,
    loaderId: frame.loaderId,
    requestId: request.requestId ?? firstString(payload.requestId, payload.request_id),
    url,
    documentUrl: request.documentUrl ?? frame.frameUrl,
    method: request.method,
    status: firstNumber(payload.status, payload.statusCode, payload.status_code, response?.status),
    statusText: firstString(payload.statusText, payload.status_text, response?.statusText, response?.status_text),
    resourceType: request.resourceType,
    timestamp,
    sequence,
    lifecycleName: firstString(payload.name, payload.lifecycle, payload.eventName, payload.event_name),
    navigationType: firstString(payload.navigationType, payload.navigation_type, payload.navigation),
    generationId: firstString(
      payload.generationId,
      payload.generation_id,
      payload.documentGeneration,
      payload.document_generation,
      payload.documentGenerationId,
      payload.document_generation_id,
      payload.documentId,
      payload.document_id,
      payload.generation,
    ),
    response,
    redirectResponse,
    canonical,
  };
}

function buildOrderIndex(events: NormalizedEvent[]): Map<number, number> {
  const requestTimes = new Map<string, number>();
  const requestTimesById = new Map<string, number>();
  const navigationTimes = new Map<string, number>();
  const navigationTimesByLoader = new Map<string, number>();
  for (const event of events) {
    if (event.requestId && event.timestamp !== null && (event.kind === "request" || event.kind === "redirect")) {
      const key = `${event.frameId ?? ""}|${event.requestId}`;
      const previous = requestTimes.get(key);
      if (previous === undefined || event.timestamp < previous) requestTimes.set(key, event.timestamp);
      const previousById = requestTimesById.get(event.requestId);
      if (previousById === undefined || event.timestamp < previousById) {
        requestTimesById.set(event.requestId, event.timestamp);
      }
    }
    if (event.loaderId && event.timestamp !== null && event.kind === "frame-navigated") {
      const key = `${event.frameId ?? ""}|${event.loaderId}`;
      const previous = navigationTimes.get(key);
      if (previous === undefined || event.timestamp < previous) navigationTimes.set(key, event.timestamp);
      const previousByLoader = navigationTimesByLoader.get(event.loaderId);
      if (previousByLoader === undefined || event.timestamp < previousByLoader) {
        navigationTimesByLoader.set(event.loaderId, event.timestamp);
      }
    }
  }

  const indexes = new Map<number, number>();
  for (const event of events) {
    let order = event.timestamp;
    if (
      order === null &&
      event.requestId &&
      (event.kind === "response" ||
        event.kind === "request-finished" ||
        event.kind === "request-failed" ||
        event.kind === "redirect")
    ) {
      order =
        requestTimes.get(`${event.frameId ?? ""}|${event.requestId}`) ??
        requestTimesById.get(event.requestId) ??
        null;
      if (order !== null) order += 1e-7;
    }
    if (
      order === null &&
      event.loaderId &&
      (event.kind === "request" || event.kind === "lifecycle")
    ) {
      order =
        navigationTimes.get(`${event.frameId ?? ""}|${event.loaderId}`) ??
        navigationTimesByLoader.get(event.loaderId) ??
        null;
      if (order !== null) order += 1e-7;
    }
    indexes.set(event.uid, order ?? Number.POSITIVE_INFINITY);
  }
  return indexes;
}

function sortEvents(events: NormalizedEvent[], ordering: NavigationTrackerOptions["ordering"] = "auto"): NormalizedEvent[] {
  const byArrival = (left: NormalizedEvent, right: NormalizedEvent) => left.uid - right.uid;
  const compareCanonical = (left: NormalizedEvent, right: NormalizedEvent) =>
    left.canonical < right.canonical ? -1 : left.canonical > right.canonical ? 1 : 0;
  if (ordering === "arrival") return [...events].sort(byArrival);

  const allHaveSequence = events.every((event) => event.sequence !== null);
  const allHaveTimestamp = events.every((event) => event.timestamp !== null);
  const useSequence = ordering === "sequence" || (ordering === "auto" && allHaveSequence);
  const useTimestamp = ordering === "timestamp" || (ordering === "auto" && !useSequence && allHaveTimestamp);

  if (useSequence) {
    return [...events].sort((left, right) => {
      const delta = (left.sequence ?? Number.POSITIVE_INFINITY) - (right.sequence ?? Number.POSITIVE_INFINITY);
      if (delta !== 0) return delta;
      const priority = KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind];
      if (priority !== 0) return priority;
      const canonical = compareCanonical(left, right);
      return canonical !== 0 ? canonical : left.uid - right.uid;
    });
  }

  if (useTimestamp) {
    return [...events].sort((left, right) => {
      const delta = (left.timestamp ?? Number.POSITIVE_INFINITY) - (right.timestamp ?? Number.POSITIVE_INFINITY);
      if (delta !== 0) return delta;
      const priority = KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind];
      if (priority !== 0) return priority;
      const canonical = compareCanonical(left, right);
      return canonical !== 0 ? canonical : left.uid - right.uid;
    });
  }

  const orderIndex = buildOrderIndex(events);
  return [...events].sort((left, right) => {
    const leftOrder = orderIndex.get(left.uid) ?? Number.POSITIVE_INFINITY;
    const rightOrder = orderIndex.get(right.uid) ?? Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1;
    const priority = KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind];
    if (priority !== 0) return priority;
    const canonical = compareCanonical(left, right);
    return canonical !== 0 ? canonical : left.uid - right.uid;
  });
}

class ModelBuilder {
  readonly options: Required<Pick<NavigationTrackerOptions, "autoCreateGenerations" | "recordLateResponses" | "unknownFrameId">>;
  frames = new Map<string, InternalFrame>();
  generations = new Map<string, InternalGeneration>();
  generationOrder: InternalGeneration[] = [];
  requests: InternalRequest[] = [];
  orphanRequests: InternalRequest[] = [];
  pendingResponses: NormalizedEvent[] = [];
  lateResponses: LateResponseRecord[] = [];
  orphanResponses: OrphanResponseRecord[] = [];
  results = new Map<number, NavigationEventResult>();
  usedGenerationIds = new Set<string>();
  loaderFrameIndex = new Map<string, string>();

  constructor(options: NavigationTrackerOptions) {
    this.options = {
      autoCreateGenerations: options.autoCreateGenerations ?? true,
      recordLateResponses: options.recordLateResponses ?? true,
      unknownFrameId: options.unknownFrameId ?? "__unknown__",
    };
  }

  apply(event: NormalizedEvent): void {
    try {
      switch (event.kind) {
        case "frame-navigated":
          this.applyFrameNavigated(event);
          break;
        case "frame-detached":
          this.applyFrameDetached(event);
          break;
        case "frame-attached":
          this.applyFrameAttached(event);
          break;
        case "same-document":
          this.applySameDocumentNavigation(event);
          break;
        case "request":
        case "redirect":
          this.applyRequest(event);
          break;
        case "response":
          this.applyResponse(event);
          break;
        case "request-finished":
        case "request-failed":
          this.applyRequestCompletion(event);
          break;
        case "lifecycle":
          this.applyLifecycle(event);
          break;
        default:
          this.results.set(event.uid, this.result(event, false, null, null, "unsupported-event"));
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "event-processing-failed";
      this.results.set(event.uid, this.result(event, false, null, null, reason));
    }
  }

  private result(
    event: NormalizedEvent,
    accepted: boolean,
    generationId: string | null,
    requestId: string | null,
    reason: string | null,
    stale = false,
    lateResponse = false,
  ): NavigationEventResult {
    return {
      accepted,
      kind: event.kind,
      eventId: event.uid,
      generationId,
      requestId,
      stale,
      lateResponse,
      reason,
    };
  }

  private ensureFrame(frameId: string, parentFrameId?: string | null): InternalFrame {
    let frame = this.frames.get(frameId);
    if (!frame) {
      frame = {
        frameId,
        parentFrameId: parentFrameId ?? null,
        currentGenerationId: null,
        detached: false,
        generations: [],
      };
      this.frames.set(frameId, frame);
    } else if (parentFrameId !== undefined && parentFrameId !== null) {
      frame.parentFrameId = parentFrameId;
    }
    return frame;
  }

  private frameForEvent(event: NormalizedEvent): InternalFrame | null {
    if (event.frameId) return this.ensureFrame(event.frameId);
    if (event.loaderId) {
      const indexedFrame = this.loaderFrameIndex.get(event.loaderId);
      if (indexedFrame) return this.ensureFrame(indexedFrame);
    }
    if (this.frames.size === 1) {
      return this.frames.values().next().value ?? null;
    }
    if (event.kind === "frame-navigated" || event.kind === "frame-attached") return null;
    return this.ensureFrame(this.options.unknownFrameId);
  }

  private generationForId(id: string | null): InternalGeneration | null {
    return id ? this.generations.get(id) ?? null : null;
  }

  private generationByLoader(frame: InternalFrame | null, loaderId: string | null): InternalGeneration | null {
    if (!loaderId) return null;
    if (frame) {
      for (let index = frame.generations.length - 1; index >= 0; index -= 1) {
        const generation = frame.generations[index];
        if (generation.loaderId === loaderId) return generation;
      }
    }
    const frameId = this.loaderFrameIndex.get(loaderId);
    if (frameId) {
      const indexed = this.frames.get(frameId);
      if (indexed) {
        for (let index = indexed.generations.length - 1; index >= 0; index -= 1) {
          const generation = indexed.generations[index];
          if (generation.loaderId === loaderId) return generation;
        }
      }
    }
    return null;
  }

  private currentGeneration(frame: InternalFrame | null): InternalGeneration | null {
    if (!frame || !frame.currentGenerationId) return null;
    const generation = this.generations.get(frame.currentGenerationId);
    return generation && generation.active ? generation : null;
  }

  private rehomeGeneration(generation: InternalGeneration, frame: InternalFrame): void {
    if (generation.frameId === frame.frameId) return;
    const previousFrame = this.frames.get(generation.frameId);
    if (previousFrame) {
      previousFrame.generations = previousFrame.generations.filter((entry) => entry.id !== generation.id);
      if (previousFrame.currentGenerationId === generation.id) previousFrame.currentGenerationId = null;
      if (
        previousFrame.frameId === this.options.unknownFrameId &&
        previousFrame.generations.length === 0 &&
        previousFrame.currentGenerationId === null
      ) {
        this.frames.delete(previousFrame.frameId);
      }
    }
    const previousFrameId = generation.frameId;
    generation.frameId = frame.frameId;
    generation.ordinal = frame.generations.length + 1;
    frame.generations.push(generation);
    for (const request of generation.requests.values()) {
      if (request.frameId === previousFrameId) request.frameId = frame.frameId;
    }
  }

  private nextGenerationId(frame: InternalFrame, loaderId: string | null, explicit: string | null): string {
    if (explicit) return explicit;
    if (loaderId) {
      const indexed = this.loaderFrameIndex.get(loaderId);
      if (!this.usedGenerationIds.has(loaderId) || indexed === frame.frameId) return loaderId;
      let suffix = 2;
      while (this.usedGenerationIds.has(`${loaderId}@${frame.frameId}:${suffix}`)) suffix += 1;
      return `${loaderId}@${frame.frameId}:${suffix}`;
    }
    let ordinal = frame.generations.length + 1;
    let candidate = `doc:${frame.frameId}:${ordinal}`;
    while (this.usedGenerationIds.has(candidate)) {
      ordinal += 1;
      candidate = `doc:${frame.frameId}:${ordinal}`;
    }
    return candidate;
  }

  private createGeneration(
    frame: InternalFrame,
    event: NormalizedEvent,
    options: {
      loaderId: string | null;
      url: string;
      parentFrameId: string | null;
      implicit: boolean;
      parentGenerationId?: string | null;
    },
  ): InternalGeneration {
    const id = this.nextGenerationId(frame, options.loaderId, event.generationId);
    const parentFrameId = options.parentFrameId ?? frame.parentFrameId;
    let parentGenerationId = options.parentGenerationId ?? null;
    if (parentGenerationId === null && parentFrameId) {
      const parentFrame = this.frames.get(parentFrameId);
      const parentGeneration = this.currentGeneration(parentFrame ?? null);
      parentGenerationId = parentGeneration?.id ?? null;
    }

    const generation: InternalGeneration = {
      id,
      frameId: frame.frameId,
      parentFrameId,
      parentGenerationId,
      loaderId: options.loaderId,
      url: options.url,
      currentUrl: options.url,
      ordinal: frame.generations.length + 1,
      state: "active",
      active: true,
      revokedAt: null,
      revokedReason: null,
      implicit: options.implicit,
      createdAt: event.timestamp,
      requests: new Map(),
      sameDocumentNavigations: [],
      lifecycleEvents: [],
      lifecycle: new Map(),
    };

    this.generations.set(id, generation);
    this.generationOrder.push(generation);
    this.usedGenerationIds.add(id);
    frame.generations.push(generation);
    frame.currentGenerationId = id;
    frame.detached = false;
    frame.parentFrameId = parentFrameId;
    if (options.loaderId) this.loaderFrameIndex.set(options.loaderId, frame.frameId);
    return generation;
  }

  private applyFrameNavigated(event: NormalizedEvent): void {
    const frame = this.frameForEvent(event);
    if (!frame) {
      this.results.set(event.uid, this.result(event, false, null, null, "missing-frame-id"));
      return;
    }
    if (event.parentFrameId) frame.parentFrameId = event.parentFrameId;

    const explicit = this.generationForId(event.generationId);
    if (explicit) {
      if (explicit.active) {
        explicit.implicit = false;
        if (event.url) {
          explicit.url = event.url;
          explicit.currentUrl = event.url;
        }
        if (event.parentFrameId) explicit.parentFrameId = event.parentFrameId;
        frame.currentGenerationId = explicit.id;
      }
      this.results.set(
        event.uid,
        this.result(event, true, explicit.id, null, explicit.active ? null : "generation-already-revoked", !explicit.active),
      );
      return;
    }

    const existingByLoader = this.generationByLoader(frame, event.loaderId);
    if (existingByLoader) {
      this.rehomeGeneration(existingByLoader, frame);
      if (existingByLoader.active) {
        existingByLoader.implicit = false;
        if (event.url) {
          existingByLoader.url = event.url;
          existingByLoader.currentUrl = event.url;
        }
        if (event.parentFrameId) existingByLoader.parentFrameId = event.parentFrameId;
        frame.currentGenerationId = existingByLoader.id;
        frame.detached = false;
      }
      this.results.set(
        event.uid,
        this.result(
          event,
          true,
          existingByLoader.id,
          null,
          existingByLoader.active ? "duplicate-navigation" : "generation-already-revoked",
          !existingByLoader.active,
        ),
      );
      return;
    }

    const previous = this.currentGeneration(frame);
    if (
      previous &&
      previous.implicit &&
      previous.loaderId === null &&
      event.loaderId !== null &&
      previous.requests.size > 0
    ) {
      previous.loaderId = event.loaderId;
      previous.implicit = false;
      previous.url = event.url ?? previous.url;
      previous.currentUrl = previous.url;
      if (event.parentFrameId) previous.parentFrameId = event.parentFrameId;
      this.loaderFrameIndex.set(event.loaderId, frame.frameId);
      frame.currentGenerationId = previous.id;
      frame.detached = false;
      this.results.set(event.uid, this.result(event, true, previous.id, null, "promoted-implicit-generation"));
      return;
    }

    if (previous) {
      this.revokeFrameSubtree(
        frame.frameId,
        previous.id,
        previous.state === "detached" ? "detached" : "navigation",
        event.timestamp,
      );
    }
    const generation = this.createGeneration(frame, event, {
      loaderId: event.loaderId,
      url: event.url ?? event.documentUrl ?? "",
      parentFrameId: event.parentFrameId ?? frame.parentFrameId,
      implicit: false,
    });
    this.results.set(event.uid, this.result(event, true, generation.id, null, null));
  }

  private applyFrameAttached(event: NormalizedEvent): void {
    if (!event.frameId) {
      this.results.set(event.uid, this.result(event, false, null, null, "missing-frame-id"));
      return;
    }
    const frame = this.ensureFrame(event.frameId, event.parentFrameId);
    frame.detached = false;
    this.results.set(event.uid, this.result(event, true, frame.currentGenerationId, null, null));
  }

  private applyFrameDetached(event: NormalizedEvent): void {
    const frame = this.frameForEvent(event);
    if (!frame) {
      this.results.set(event.uid, this.result(event, false, null, null, "missing-frame-id"));
      return;
    }
    const current = this.currentGeneration(frame);
    this.revokeFrameSubtree(frame.frameId, current?.id ?? null, "detached", event.timestamp);
    frame.detached = true;
    frame.currentGenerationId = null;
    this.results.set(event.uid, this.result(event, true, current?.id ?? null, null, null));
  }

  private collectSubtreeFrameIds(frameId: string): Set<string> {
    const result = new Set<string>([frameId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const frame of this.frames.values()) {
        if (frame.parentFrameId && result.has(frame.parentFrameId) && !result.has(frame.frameId)) {
          result.add(frame.frameId);
          changed = true;
        }
      }
    }
    return result;
  }

  private generationDescendsFrom(generation: InternalGeneration, ancestorId: string): boolean {
    let parentId = generation.parentGenerationId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      if (parentId === ancestorId) return true;
      visited.add(parentId);
      parentId = this.generations.get(parentId)?.parentGenerationId ?? null;
    }
    return false;
  }

  private revokeFrameSubtree(
    frameId: string,
    rootGenerationId: string | null,
    reason: string,
    timestamp: number | null,
  ): void {
    const frameIds = this.collectSubtreeFrameIds(frameId);
    for (const generation of this.generationOrder) {
      if (!generation.active) continue;
      const isRoot = rootGenerationId !== null && generation.id === rootGenerationId;
      const belongsToSubtree =
        frameIds.has(generation.frameId) ||
        (rootGenerationId !== null && this.generationDescendsFrom(generation, rootGenerationId));
      if (!isRoot && !belongsToSubtree) continue;
      generation.active = false;
      generation.state = reason === "detached" ? "detached" : "superseded";
      generation.revokedAt = timestamp;
      generation.revokedReason = generation.frameId === frameId ? reason : `ancestor-${reason}`;
      const frame = this.frames.get(generation.frameId);
      if (frame?.currentGenerationId === generation.id) frame.currentGenerationId = null;
    }
    if (rootGenerationId) {
      const root = this.generations.get(rootGenerationId);
      if (root) root.revokedReason = reason;
    }
  }

  private resolveExistingGeneration(event: NormalizedEvent): InternalGeneration | null {
    const explicit = this.generationForId(event.generationId);
    if (explicit) return explicit;
    const frame = this.frameForEvent(event);
    if (!frame) return null;
    const byLoader = this.generationByLoader(frame, event.loaderId);
    if (byLoader) {
      this.rehomeGeneration(byLoader, frame);
      return byLoader;
    }
    if (event.loaderId && frame.currentGenerationId) {
      const current = this.currentGeneration(frame);
      if (current && current.loaderId === null) {
        current.loaderId = event.loaderId;
        this.loaderFrameIndex.set(event.loaderId, frame.frameId);
        return current;
      }
      if (current && current.loaderId !== event.loaderId) return null;
    }
    return this.currentGeneration(frame);
  }

  private resolveOrCreateGeneration(event: NormalizedEvent): InternalGeneration | null {
    const existing = this.resolveExistingGeneration(event);
    if (existing) return existing;
    const frame = this.frameForEvent(event);
    if (!frame || frame.detached || !this.options.autoCreateGenerations) return null;
    const current = this.currentGeneration(frame);
    if (event.loaderId && current && current.loaderId !== null && current.loaderId !== event.loaderId) {
      return null;
    }
    return this.createGeneration(frame, event, {
      loaderId: event.loaderId,
      url: event.documentUrl ?? event.url ?? "",
      parentFrameId: frame.parentFrameId,
      implicit: true,
    });
  }

  private resolveGenerationForRequest(event: NormalizedEvent): InternalGeneration | null {
    const explicit = this.generationForId(event.generationId);
    if (explicit) return explicit;
    const frame = this.frameForEvent(event);
    if (!frame) return null;

    const byLoader = this.generationByLoader(frame, event.loaderId);
    if (byLoader) {
      this.rehomeGeneration(byLoader, frame);
      return byLoader;
    }

    const current = this.currentGeneration(frame);
    if (event.loaderId) {
      if (current && current.loaderId === null) {
        current.loaderId = event.loaderId;
        this.loaderFrameIndex.set(event.loaderId, frame.frameId);
        return current;
      }
      if (current && current.loaderId !== null && current.loaderId !== event.loaderId) {
        return null;
      }
      if (current) return current;
    } else if (current) {
      return current;
    }

    if (frame.detached || !this.options.autoCreateGenerations) return null;
    return this.createGeneration(frame, event, {
      loaderId: event.loaderId,
      url: event.documentUrl ?? event.url ?? "",
      parentFrameId: frame.parentFrameId,
      implicit: true,
    });
  }

  private applySameDocumentNavigation(event: NormalizedEvent): void {
    const generation = this.resolveOrCreateGeneration(event);
    if (!generation) {
      this.results.set(event.uid, this.result(event, false, null, null, "no-document-generation"));
      return;
    }
    const record: SameDocumentNavigationRecord = {
      url: event.url ?? generation.currentUrl,
      timestamp: event.timestamp,
      navigationType: event.navigationType,
      stale: !generation.active,
    };
    generation.sameDocumentNavigations.push(record);
    if (event.url) {
      generation.currentUrl = event.url;
      const frame = this.frames.get(generation.frameId);
      if (frame?.currentGenerationId === generation.id) frame.detached = false;
    }
    this.results.set(
      event.uid,
      this.result(event, true, generation.id, null, generation.active ? null : "stale-same-document-navigation", !generation.active),
    );
  }

  private applyRequest(event: NormalizedEvent): void {
    if (!event.requestId) {
      this.results.set(event.uid, this.result(event, false, null, null, "missing-request-id"));
      return;
    }
    let generation: InternalGeneration | null = null;
    const hasGenerationHint = Boolean(event.frameId || event.loaderId || event.generationId);
    if (!hasGenerationHint) {
      const candidates = this.findRequestCandidates(event);
      const existingRequest = candidates[candidates.length - 1];
      generation = existingRequest ? this.generationForId(existingRequest.generationId) : null;
    }
    generation ??= this.resolveGenerationForRequest(event);
    if (!generation) {
      const orphan = this.makeRequest(event, "orphan");
      this.orphanRequests.push(orphan);
      this.results.set(event.uid, this.result(event, false, null, event.requestId, "no-document-generation"));
      return;
    }

    const existing = generation.requests.get(event.requestId) ?? null;
    if (!existing) {
      const request = this.makeRequest(event, generation.id);
      generation.requests.set(request.requestId, request);
      this.requests.push(request);
      if (event.kind === "redirect" || event.redirectResponse) {
        const initialFrom = firstString(
          event.raw.fromUrl,
          event.raw.from_url,
          event.raw.from,
          event.redirectResponse?.url,
        );
        if (initialFrom && initialFrom !== request.url) {
          request.url = initialFrom;
          request.originalUrl = initialFrom;
          this.applyRedirect(request, event);
        }
      }
      this.attachPendingResponses(request);
      this.results.set(
        event.uid,
        this.result(event, true, generation.id, event.requestId, generation.active ? null : "stale-request", !generation.active),
      );
      return;
    }

    if (event.kind === "redirect" || event.redirectResponse) {
      this.applyRedirect(existing, event);
      this.results.set(
        event.uid,
        this.result(event, true, generation.id, event.requestId, generation.active ? null : "stale-redirect", !generation.active),
      );
      return;
    }

    if (event.url && event.url !== existing.url) existing.url = event.url;
    if (event.method) existing.method = event.method;
    if (event.resourceType) existing.resourceType = event.resourceType;
    if (event.loaderId && !existing.loaderId) existing.loaderId = event.loaderId;
    this.results.set(event.uid, this.result(event, true, generation.id, event.requestId, "duplicate-request", !generation.active));
  }

  private makeRequest(event: NormalizedEvent, generationId: string): InternalRequest {
    const url = event.url ?? "";
    const generationFrameId = this.generationForId(generationId)?.frameId;
    return {
      requestId: event.requestId ?? "",
      frameId: event.frameId ?? generationFrameId ?? this.options.unknownFrameId,
      generationId,
      loaderId: event.loaderId,
      url,
      originalUrl: url,
      method: event.method,
      resourceType: event.resourceType,
      redirects: [],
      response: null,
      startedAt: event.timestamp,
      respondedAt: null,
      finishedAt: null,
      lateResponse: false,
      finished: false,
      failed: false,
      failure: null,
      canceled: false,
      order: nextRequestOrder++,
    };
  }

  private applyRedirect(request: InternalRequest, event: NormalizedEvent): void {
    const redirectResponse = event.redirectResponse;
    const from = firstString(
      event.raw.fromUrl,
      event.raw.from_url,
      event.raw.from,
      request.url,
      redirectResponse?.url,
    );
    const to =
      firstString(
        event.url,
        event.raw.toUrl,
        event.raw.to_url,
        event.raw.to,
        event.raw.redirectUrl,
        event.raw.redirect_url,
        request.url,
      ) ?? request.url;
    request.redirects.push({
      from,
      to,
      status: event.status ?? firstNumber(redirectResponse?.status, redirectResponse?.statusCode),
      statusText: event.statusText ?? firstString(redirectResponse?.statusText, redirectResponse?.status_text),
      location: firstString(
        event.raw.location,
        headerValue(redirectResponse?.headers, "location"),
      ),
      timestamp: event.timestamp,
    });
    request.url = to;
    if (event.method) request.method = event.method;
    if (event.resourceType) request.resourceType = event.resourceType;
  }

  private findRequestCandidates(event: NormalizedEvent): InternalRequest[] {
    if (!event.requestId) return [];
    return this.requests.filter((request) => request.requestId === event.requestId);
  }

  private findRequestForResponse(event: NormalizedEvent): {
    request: InternalRequest | null;
    reason: string | null;
  } {
    const candidates = this.findRequestCandidates(event);
    if (candidates.length === 0) return { request: null, reason: null };

    const explicit = this.generationForId(event.generationId);
    if (explicit) {
      const exact = candidates.find((request) => request.generationId === explicit.id) ?? null;
      return { request: exact, reason: exact ? null : "generation-mismatch" };
    }

    if (event.loaderId) {
      const exact = candidates.filter((request) => {
        const generation = this.generationForId(request.generationId);
        return generation?.loaderId === event.loaderId;
      });
      if (exact.length > 0) return { request: exact[exact.length - 1], reason: null };
      const sameLoaderless = candidates.filter((request) => this.generationForId(request.generationId)?.loaderId === null);
      if (sameLoaderless.length > 0) return { request: sameLoaderless[sameLoaderless.length - 1], reason: null };
      return { request: null, reason: "loader-mismatch" };
    }

    if (event.url) {
      const urlMatches = candidates.filter((request) => request.url === event.url);
      if (urlMatches.length > 0) return { request: urlMatches[urlMatches.length - 1], reason: null };
    }

    if (event.frameId) {
      const exact = candidates.filter((request) => request.frameId === event.frameId);
      if (exact.length > 0) return { request: exact[exact.length - 1], reason: null };
    }
    return { request: candidates[candidates.length - 1], reason: null };
  }

  private applyResponse(event: NormalizedEvent): void {
    if (!event.requestId) {
      this.results.set(event.uid, this.result(event, false, null, null, "missing-request-id"));
      return;
    }
    const found = this.findRequestForResponse(event);
    if (!found.request) {
      const pending = this.pendingResponses.some((entry) => entry.requestId === event.requestId);
      if (!pending) this.pendingResponses.push(event);
      if (found.reason) {
        this.orphanResponses.push({
          requestId: event.requestId,
          frameId: event.frameId,
          loaderId: event.loaderId,
          status: event.status,
          url: event.url,
          timestamp: event.timestamp,
          reason: found.reason,
        });
      }
      this.results.set(event.uid, this.result(event, false, null, event.requestId, found.reason ?? "request-not-seen-yet"));
      return;
    }
    this.attachResponse(found.request, event);
  }

  private attachPendingResponses(request: InternalRequest): void {
    const remaining: NormalizedEvent[] = [];
    for (const pending of this.pendingResponses) {
      if (pending.requestId !== request.requestId) {
        remaining.push(pending);
        continue;
      }
      if (pending.loaderId && request.loaderId && pending.loaderId !== request.loaderId) {
        remaining.push(pending);
        continue;
      }
      if (pending.frameId && request.frameId && pending.frameId !== request.frameId) {
        remaining.push(pending);
        continue;
      }
      this.attachResponse(request, pending);
    }
    this.pendingResponses = remaining;
  }

  private attachResponse(request: InternalRequest, event: NormalizedEvent): void {
    const generation = this.generationForId(request.generationId);
    const response = this.makeResponse(event);
    request.response = response;
    request.respondedAt = event.timestamp;

    if (!generation || !generation.active) {
      request.lateResponse = true;
      if (this.options.recordLateResponses) {
        const frame = generation ? this.frames.get(generation.frameId) : null;
        this.lateResponses.push({
          requestId: request.requestId,
          frameId: request.frameId,
          requestGenerationId: request.generationId,
          attachedToGenerationId: request.generationId,
          currentGenerationId: frame?.currentGenerationId ?? null,
          status: response.status,
          url: response.url,
          timestamp: event.timestamp,
          reason: "request-generation-not-active",
        });
      }
      this.results.set(
        event.uid,
        this.result(event, true, request.generationId, request.requestId, "late-response", true, true),
      );
      return;
    }

    this.results.set(event.uid, this.result(event, true, request.generationId, request.requestId, null));
  }

  private makeResponse(event: NormalizedEvent): ResponseRecord {
    const raw = event.response;
    return {
      url: firstString(raw?.url, event.url),
      status: event.status,
      statusText: event.statusText,
      mimeType: firstString(raw?.mimeType, raw?.mime_type),
      headers: isRecord(raw?.headers) ? { ...raw.headers } : null,
      fromDiskCache: typeof raw?.fromDiskCache === "boolean" ? raw.fromDiskCache : null,
      fromServiceWorker: typeof raw?.fromServiceWorker === "boolean" ? raw.fromServiceWorker : null,
      timestamp: event.timestamp,
      loaderId: event.loaderId,
      raw,
    };
  }

  private applyRequestCompletion(event: NormalizedEvent): void {
    if (!event.requestId) {
      this.results.set(event.uid, this.result(event, false, null, null, "missing-request-id"));
      return;
    }
    const found = this.findRequestForResponse(event);
    if (!found.request) {
      this.results.set(event.uid, this.result(event, false, null, event.requestId, found.reason ?? "request-not-seen-yet"));
      return;
    }
    const request = found.request;
    const generation = this.generationForId(request.generationId);
    request.finishedAt = event.timestamp;
    if (event.kind === "request-failed") {
      request.failed = true;
      request.failure = firstString(event.raw.errorText, event.raw.error, event.raw.blockedReason);
      request.canceled = event.raw.canceled === true;
    } else {
      request.finished = true;
    }
    const stale = !generation || !generation.active;
    this.results.set(
      event.uid,
      this.result(event, true, request.generationId, request.requestId, stale ? "stale-request-completion" : null, stale),
    );
  }

  private applyLifecycle(event: NormalizedEvent): void {
    const generation = this.resolveOrCreateGeneration(event);
    if (!generation) {
      this.results.set(event.uid, this.result(event, false, null, null, "no-document-generation"));
      return;
    }
    const record: LifecycleRecord = {
      name: event.lifecycleName ?? "unknown",
      timestamp: event.timestamp,
      loaderId: event.loaderId,
      stale: !generation.active,
    };
    generation.lifecycleEvents.push(record);
    generation.lifecycle.set(record.name, record);
    this.results.set(
      event.uid,
      this.result(event, true, generation.id, null, generation.active ? null : "stale-lifecycle-event", !generation.active),
    );
  }

  private snapshotRequest(request: InternalRequest): RequestRecord {
    const generation = this.generationForId(request.generationId);
    const active = generation?.active === true;
    return {
      requestId: request.requestId,
      frameId: request.frameId,
      generationId: request.generationId,
      documentGeneration: request.generationId,
      loaderId: request.loaderId,
      url: request.url,
      originalUrl: request.originalUrl,
      method: request.method,
      resourceType: request.resourceType,
      redirects: request.redirects.map((redirect) => ({ ...redirect })),
      response: request.response ? { ...request.response } : null,
      startedAt: request.startedAt,
      respondedAt: request.respondedAt,
      finishedAt: request.finishedAt,
      lateResponse: request.lateResponse,
      stale: !active,
      active,
      finished: request.finished,
      failed: request.failed,
      failure: request.failure,
      canceled: request.canceled,
    };
  }

  private snapshotGeneration(generation: InternalGeneration): DocumentGeneration {
    const requests = [...generation.requests.values()]
      .sort((left, right) => left.order - right.order)
      .map((request) => this.snapshotRequest(request));
    const childGenerationIds = this.generationOrder
      .filter((child) => child.parentGenerationId === generation.id)
      .map((child) => child.id);
    const childFrameIds = childGenerationIds
      .map((id) => this.generationForId(id)?.frameId)
      .filter((frameId): frameId is string => Boolean(frameId));
    return {
      id: generation.id,
      generationId: generation.id,
      documentGeneration: generation.id,
      frameId: generation.frameId,
      parentFrameId: generation.parentFrameId,
      parentGenerationId: generation.parentGenerationId,
      loaderId: generation.loaderId,
      url: generation.url,
      currentUrl: generation.currentUrl,
      ordinal: generation.ordinal,
      state: generation.state,
      active: generation.active,
      revoked: !generation.active,
      revokedAt: generation.revokedAt,
      revokedReason: generation.revokedReason,
      implicit: generation.implicit,
      createdAt: generation.createdAt,
      requests,
      sameDocumentNavigations: generation.sameDocumentNavigations.map((entry) => ({ ...entry })),
      lifecycleEvents: generation.lifecycleEvents.map((entry) => ({ ...entry })),
      lifecycle: Object.fromEntries(
        [...generation.lifecycle.entries()].map(([name, entry]) => [name, { ...entry }]),
      ),
      childGenerationIds,
      childFrameIds,
    };
  }

  private buildRequestTree(includeInactive: boolean): RequestTreeNode[] {
    const included = this.generationOrder.filter((generation) => includeInactive || generation.active);
    const includedIds = new Set(included.map((generation) => generation.id));
    const nodes = new Map<string, RequestTreeNode>();
    for (const generation of included) {
      nodes.set(generation.id, {
        id: generation.id,
        generationId: generation.id,
        documentGeneration: generation.id,
        frameId: generation.frameId,
        loaderId: generation.loaderId,
        url: generation.currentUrl,
        parentGenerationId: generation.parentGenerationId,
        active: generation.active,
        requests: [...generation.requests.values()]
          .sort((left, right) => left.order - right.order)
          .map((request) => this.snapshotRequest(request)),
        children: [],
      });
    }
    const roots: RequestTreeNode[] = [];
    for (const generation of included) {
      const node = nodes.get(generation.id);
      if (!node) continue;
      const parent = generation.parentGenerationId ? nodes.get(generation.parentGenerationId) : null;
      if (parent && includedIds.has(parent.generationId)) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  finish(): NavigationSnapshot {
    const generations = this.generationOrder.map((generation) => this.snapshotGeneration(generation));
    const activeGenerations = generations.filter((generation) => generation.active);
    const activeRequests = activeGenerations.flatMap((generation) => generation.requests);
    const allRequests = generations.flatMap((generation) => generation.requests);
    const requestTree = this.buildRequestTree(false);
    const fullRequestTree = this.buildRequestTree(true);
    const frames: FrameState[] = [...this.frames.values()].map((frame) => ({
      frameId: frame.frameId,
      parentFrameId: frame.parentFrameId,
      currentGenerationId: frame.currentGenerationId,
      detached: frame.detached,
      generationIds: frame.generations.map((generation) => generation.id),
    }));
    const requestsByGeneration: Record<string, RequestRecord[]> = {};
    for (const generation of generations) {
      requestsByGeneration[generation.id] = generation.requests;
    }
    const orphanResponses = this.orphanResponses.map((entry) => ({ ...entry }));
    for (const pending of this.pendingResponses) {
      orphanResponses.push({
        requestId: pending.requestId ?? "",
        frameId: pending.frameId,
        loaderId: pending.loaderId,
        status: pending.status,
        url: pending.url,
        timestamp: pending.timestamp,
        reason: "request-not-seen",
      });
    }
    return {
      frames,
      generations,
      activeGenerations,
      requestTree,
      tree: requestTree,
      fullRequestTree,
      requests: activeRequests,
      activeRequests,
      allRequests,
      requestsByGeneration,
      lateResponses: this.lateResponses.map((entry) => ({ ...entry })),
      orphanResponses,
    };
  }
}

/**
 * Navigation generation tracker.
 *
 * ```ts
 * const tracker = new NavigationTracker();
 * tracker.onFrameNavigated({ frameId: "main", loaderId: "doc-1", url: "https://a" });
 * tracker.onRequestWillBeSent({ frameId: "main", requestId: "r1", url: "https://a/x" });
 * ```
 */
export class NavigationTracker {
  private options: NavigationTrackerOptions;
  private normalizedEvents: NormalizedEvent[] = [];
  private dirty = true;
  private cached: NavigationSnapshot | null = null;
  private lastResults = new Map<number, NavigationEventResult>();

  constructor(options?: NavigationTrackerOptions);
  constructor(events?: NavigationEventInput[], options?: NavigationTrackerOptions);
  constructor(
    optionsOrEvents: NavigationTrackerOptions | NavigationEventInput[] = {},
    options: NavigationTrackerOptions = {},
  ) {
    if (Array.isArray(optionsOrEvents)) {
      this.options = options;
      this.replay(optionsOrEvents);
    } else {
      this.options = optionsOrEvents;
    }
  }

  get eventCount(): number {
    return this.normalizedEvents.length;
  }

  get snapshot(): NavigationSnapshot {
    return this.read();
  }

  get requestTree(): RequestTreeNode[] {
    return this.read().requestTree;
  }

  get tree(): RequestTreeNode[] {
    return this.read().requestTree;
  }

  get fullRequestTree(): RequestTreeNode[] {
    return this.read().fullRequestTree;
  }

  get generations(): DocumentGeneration[] {
    return this.read().generations;
  }

  get activeGenerations(): DocumentGeneration[] {
    return this.read().activeGenerations;
  }

  get frames(): FrameState[] {
    return this.read().frames;
  }

  get requests(): RequestRecord[] {
    return this.read().activeRequests;
  }

  get activeRequests(): RequestRecord[] {
    return this.read().activeRequests;
  }

  get allRequests(): RequestRecord[] {
    return this.read().allRequests;
  }

  get requestsByGeneration(): Record<string, RequestRecord[]> {
    return this.read().requestsByGeneration;
  }

  get lateResponses(): LateResponseRecord[] {
    return this.read().lateResponses;
  }

  get orphanResponses(): OrphanResponseRecord[] {
    return this.read().orphanResponses;
  }

  ingest(input: NavigationEventInput): NavigationEventResult;
  ingest(kind: NavigationEventKind | string, input: NavigationEventInput): NavigationEventResult;
  ingest(
    inputOrKind: NavigationEventInput | NavigationEventKind | string,
    maybeInput?: NavigationEventInput,
  ): NavigationEventResult {
    let input: NavigationEventInput;
    let forcedKind: NavigationEventKind | null = null;
    if (typeof inputOrKind === "string") {
      input = maybeInput ?? {};
      forcedKind = normalizeKind(inputOrKind);
    } else {
      input = inputOrKind;
    }
    const event = normalizeEvent(input, forcedKind);
    if (!event) {
      return {
        accepted: false,
        kind: null,
        eventId: null,
        generationId: null,
        requestId: null,
        stale: false,
        lateResponse: false,
        reason: "unknown-event-kind",
      };
    }
    this.normalizedEvents.push(event);
    this.dirty = true;
    this.read();
    return (
      this.lastResults.get(event.uid) ?? {
        accepted: false,
        kind: event.kind,
        eventId: event.uid,
        generationId: null,
        requestId: event.requestId,
        stale: false,
        lateResponse: false,
        reason: "no-result",
      }
    );
  }

  /** Alias for `ingest`. */
  handle(input: NavigationEventInput): NavigationEventResult;
  handle(kind: NavigationEventKind | string, input: NavigationEventInput): NavigationEventResult;
  handle(
    inputOrKind: NavigationEventInput | NavigationEventKind | string,
    maybeInput?: NavigationEventInput,
  ): NavigationEventResult {
    return typeof inputOrKind === "string"
      ? this.ingest(inputOrKind, maybeInput ?? {})
      : this.ingest(inputOrKind);
  }

  /** Alias for `ingest`. */
  dispatch(input: NavigationEventInput): NavigationEventResult;
  dispatch(kind: NavigationEventKind | string, input: NavigationEventInput): NavigationEventResult;
  dispatch(
    inputOrKind: NavigationEventInput | NavigationEventKind | string,
    maybeInput?: NavigationEventInput,
  ): NavigationEventResult {
    return typeof inputOrKind === "string"
      ? this.ingest(inputOrKind, maybeInput ?? {})
      : this.ingest(inputOrKind);
  }

  /** Alias for `ingest`. */
  process(input: NavigationEventInput): NavigationEventResult;
  process(kind: NavigationEventKind | string, input: NavigationEventInput): NavigationEventResult;
  process(
    inputOrKind: NavigationEventInput | NavigationEventKind | string,
    maybeInput?: NavigationEventInput,
  ): NavigationEventResult {
    return typeof inputOrKind === "string"
      ? this.ingest(inputOrKind, maybeInput ?? {})
      : this.ingest(inputOrKind);
  }

  /** EventEmitter-style alias for `ingest`. */
  on(input: NavigationEventInput): NavigationEventResult;
  on(kind: NavigationEventKind | string, input: NavigationEventInput): NavigationEventResult;
  on(
    inputOrKind: NavigationEventInput | NavigationEventKind | string,
    maybeInput?: NavigationEventInput,
  ): NavigationEventResult {
    return typeof inputOrKind === "string"
      ? this.ingest(inputOrKind, maybeInput ?? {})
      : this.ingest(inputOrKind);
  }

  /** Replace the event log and rebuild from a canonical ordering. */
  replay(events: NavigationEventInput[], options: NavigationTrackerOptions = this.options): NavigationSnapshot {
    this.options = options;
    this.normalizedEvents = [];
    this.cached = null;
    this.dirty = true;
    for (const input of events) {
      const event = normalizeEvent(input);
      if (event) this.normalizedEvents.push(event);
    }
    return this.read();
  }

  reset(): void {
    this.normalizedEvents = [];
    this.cached = null;
    this.lastResults = new Map();
    this.dirty = true;
  }

  onFrameNavigated(input: NavigationEventInput): NavigationEventResult;
  onFrameNavigated(
    frameId: string,
    url?: string,
    loaderId?: string | null,
    parentFrameId?: string | null,
  ): NavigationEventResult;
  onFrameNavigated(
    inputOrFrameId: NavigationEventInput | string,
    url?: string,
    loaderId?: string | null,
    parentFrameId?: string | null,
  ): NavigationEventResult {
    const input = typeof inputOrFrameId === "string"
      ? { frameId: inputOrFrameId, url, loaderId, parentId: parentFrameId }
      : inputOrFrameId;
    return this.ingest("frame-navigated", input);
  }

  /** Alias for `onFrameNavigated`. */
  onNavigation(input: NavigationEventInput): NavigationEventResult {
    return this.ingest("frame-navigated", input);
  }

  onFrameDetached(input: NavigationEventInput): NavigationEventResult;
  onFrameDetached(frameId: string): NavigationEventResult;
  onFrameDetached(inputOrFrameId: NavigationEventInput | string): NavigationEventResult {
    return this.ingest(
      "frame-detached",
      typeof inputOrFrameId === "string" ? { frameId: inputOrFrameId } : inputOrFrameId,
    );
  }

  onFrameAttached(input: NavigationEventInput): NavigationEventResult;
  onFrameAttached(frameId: string, parentFrameId?: string | null): NavigationEventResult;
  onFrameAttached(
    inputOrFrameId: NavigationEventInput | string,
    parentFrameId?: string | null,
  ): NavigationEventResult {
    const input = typeof inputOrFrameId === "string"
      ? { frameId: inputOrFrameId, parentId: parentFrameId }
      : inputOrFrameId;
    return this.ingest("frame-attached", input);
  }

  onRequest(input: NavigationEventInput): NavigationEventResult {
    return this.ingest("request", input);
  }

  onRequestWillBeSent(input: NavigationEventInput): NavigationEventResult {
    return this.ingest("request", input);
  }

  onRedirect(input: NavigationEventInput): NavigationEventResult {
    return this.ingest("redirect", input);
  }

  onResponse(input: NavigationEventInput): NavigationEventResult {
    return this.ingest("response", input);
  }

  onResponseReceived(input: NavigationEventInput): NavigationEventResult {
    return this.ingest("response", input);
  }

  onRequestFinished(input: NavigationEventInput): NavigationEventResult {
    return this.ingest("request-finished", input);
  }

  onLoadingFinished(input: NavigationEventInput): NavigationEventResult {
    return this.ingest("request-finished", input);
  }

  onRequestFailed(input: NavigationEventInput): NavigationEventResult {
    return this.ingest("request-failed", input);
  }

  onLoadingFailed(input: NavigationEventInput): NavigationEventResult {
    return this.ingest("request-failed", input);
  }

  onSameDocumentNavigation(input: NavigationEventInput): NavigationEventResult {
    return this.ingest("same-document", input);
  }

  onNavigatedWithinDocument(input: NavigationEventInput): NavigationEventResult {
    return this.ingest("same-document", input);
  }

  onLifecycle(input: NavigationEventInput): NavigationEventResult {
    return this.ingest("lifecycle", input);
  }

  onLifecycleEvent(input: NavigationEventInput): NavigationEventResult {
    return this.ingest("lifecycle", input);
  }

  getGeneration(frameIdOrGenerationId: string, generationId?: string): DocumentGeneration | null {
    const snapshot = this.read();
    if (generationId) {
      return snapshot.generations.find((generation) => generation.id === generationId) ?? null;
    }
    const byGeneration = snapshot.generations.find(
      (generation) => generation.id === frameIdOrGenerationId,
    );
    if (byGeneration) return byGeneration;
    const frame = snapshot.frames.find((entry) => entry.frameId === frameIdOrGenerationId);
    if (!frame?.currentGenerationId) return null;
    return (
      snapshot.generations.find((generation) => generation.id === frame.currentGenerationId) ??
      null
    );
  }

  getDocumentGeneration(frameIdOrGenerationId: string, generationId?: string): DocumentGeneration | null {
    return this.getGeneration(frameIdOrGenerationId, generationId);
  }

  getGenerationById(generationId: string): DocumentGeneration | null {
    return this.getGeneration(generationId, generationId);
  }

  getCurrentGeneration(frameId: string): DocumentGeneration | null {
    return this.getGeneration(frameId);
  }

  getActiveGenerationId(frameId: string): string | null {
    return this.getGeneration(frameId)?.id ?? null;
  }

  isGenerationActive(generationId: string): boolean {
    return this.getGeneration(generationId)?.active === true;
  }

  getRequests(frameIdOrGenerationId?: string, generationId?: string): RequestRecord[] {
    const snapshot = this.read();
    if (generationId) return snapshot.requestsByGeneration[generationId] ?? [];
    if (!frameIdOrGenerationId) return snapshot.activeRequests;
    const generation = this.getGeneration(frameIdOrGenerationId);
    return generation ? generation.requests : [];
  }

  getRequestsForFrame(frameId: string): RequestRecord[] {
    return this.getRequests(frameId);
  }

  getRequestsForGeneration(generationId: string): RequestRecord[] {
    return this.getRequests(generationId, generationId);
  }

  getAllRequests(): RequestRecord[] {
    return this.read().allRequests;
  }

  getRequestsByGeneration(): Record<string, RequestRecord[]> {
    return this.read().requestsByGeneration;
  }

  getRequest(requestId: string): RequestRecord | null {
    const requests = this.read().allRequests.filter((request) => request.requestId === requestId);
    return requests.length > 0 ? requests[requests.length - 1] : null;
  }

  getRedirectChain(requestId: string): RedirectRecord[] {
    return this.getRequest(requestId)?.redirects ?? [];
  }

  getSnapshot(): NavigationSnapshot {
    return this.read();
  }

  toJSON(): NavigationSnapshot {
    return this.read();
  }

  getTree(): RequestTreeNode[] {
    return this.read().requestTree;
  }

  getRequestTree(): RequestTreeNode[] {
    return this.read().requestTree;
  }

  getFrame(frameId: string): FrameState | null {
    return this.read().frames.find((frame) => frame.frameId === frameId) ?? null;
  }

  getGenerationForFrame(frameId: string): DocumentGeneration | null {
    return this.getGeneration(frameId);
  }

  getGenerationForRequest(requestId: string): DocumentGeneration | null {
    const request = this.getRequest(requestId);
    return request ? this.getGeneration(request.generationId) : null;
  }

  getLateResponses(): LateResponseRecord[] {
    return this.read().lateResponses;
  }

  getOrphanResponses(): OrphanResponseRecord[] {
    return this.read().orphanResponses;
  }

  bindFrameNavigated(input: NavigationEventInput): NavigationEventResult {
    return this.onFrameNavigated(input);
  }

  bindFrameDetach(input: NavigationEventInput): NavigationEventResult {
    return this.onFrameDetached(input);
  }

  bindRequest(input: NavigationEventInput): NavigationEventResult {
    return this.onRequest(input);
  }

  bindRedirect(input: NavigationEventInput): NavigationEventResult {
    return this.onRedirect(input);
  }

  bindResponse(input: NavigationEventInput): NavigationEventResult {
    return this.onResponse(input);
  }

  bindSameDocumentNavigation(input: NavigationEventInput): NavigationEventResult {
    return this.onSameDocumentNavigation(input);
  }

  bindLifecycle(input: NavigationEventInput): NavigationEventResult {
    return this.onLifecycle(input);
  }

  attribute(input: NavigationEventInput): NavigationEventResult;
  attribute(kind: NavigationEventKind | string, input: NavigationEventInput): NavigationEventResult;
  attribute(
    inputOrKind: NavigationEventInput | NavigationEventKind | string,
    maybeInput?: NavigationEventInput,
  ): NavigationEventResult {
    return typeof inputOrKind === "string"
      ? this.ingest(inputOrKind, maybeInput ?? {})
      : this.ingest(inputOrKind);
  }

  private read(): NavigationSnapshot {
    if (!this.dirty && this.cached) return this.cached;
    const builder = new ModelBuilder(this.options);
    for (const event of sortEvents(this.normalizedEvents, this.options.ordering)) {
      builder.apply(event);
    }
    this.cached = builder.finish();
    this.lastResults = builder.results;
    this.dirty = false;
    return this.cached;
  }
}

function normalizeKind(kind: string): NavigationEventKind | null {
  const direct = KIND_ALIASES[kind];
  if (direct) return direct;
  const normalized = normalizeKey(kind);
  return KIND_ALIASES[normalized] ?? KIND_ALIASES[normalized.replace(/-/g, "")] ?? null;
}

/** Create a tracker with a concise factory API. */
export function createNavigationTracker(
  optionsOrEvents?: NavigationTrackerOptions | NavigationEventInput[],
  options?: NavigationTrackerOptions,
): NavigationTracker {
  return Array.isArray(optionsOrEvents)
    ? new NavigationTracker(optionsOrEvents, options)
    : new NavigationTracker(optionsOrEvents ?? {});
}

export const createNavigationAttributor = createNavigationTracker;
export const createDocumentGenerationTracker = createNavigationTracker;

/** Replay events into a plain, JSON-friendly snapshot. */
export function replayNavigationEvents(
  events: NavigationEventInput[],
  options?: NavigationTrackerOptions,
): NavigationSnapshot {
  return new NavigationTracker(events, options).snapshot;
}

/** Alias for `replayNavigationEvents`. */
export function replayNavigation(
  events: NavigationEventInput[],
  options?: NavigationTrackerOptions,
): NavigationSnapshot {
  return replayNavigationEvents(events, options);
}

/** Alias for `replayNavigationEvents`. */
export function attributeNavigationEvents(
  events: NavigationEventInput[],
  options?: NavigationTrackerOptions,
): NavigationSnapshot {
  return replayNavigationEvents(events, options);
}

/** Alias for `replayNavigationEvents`. */
export function replayEvents(
  events: NavigationEventInput[],
  options?: NavigationTrackerOptions,
): NavigationSnapshot {
  return replayNavigationEvents(events, options);
}

/** Build only the active request tree from a batch of events. */
export function buildRequestTree(
  events: NavigationEventInput[],
  options?: NavigationTrackerOptions,
): RequestTreeNode[] {
  return replayNavigationEvents(events, options).requestTree;
}

/** Alias kept for callers that use the component name. */
export const NavigationAttribution = NavigationTracker;
export const NavigationAttributor = NavigationTracker;
export const DocumentGenerationTracker = NavigationTracker;
export const RequestNavigationTracker = NavigationTracker;
export const DocumentGenerationRegistry = NavigationTracker;
export const NavigationManager = NavigationTracker;
export const FrameNavigationTracker = NavigationTracker;
export const NavigationAttributionTracker = NavigationTracker;
export const DocumentGenerationAttributor = NavigationTracker;

export type NavigationAttribution = NavigationTracker;
export type NavigationAttributor = NavigationTracker;
export type DocumentGenerationTracker = NavigationTracker;
export type RequestNavigationTracker = NavigationTracker;
export type DocumentGenerationRegistry = NavigationTracker;
export type NavigationManager = NavigationTracker;
export type FrameNavigationTracker = NavigationTracker;
export type NavigationAttributionTracker = NavigationTracker;
export type DocumentGenerationAttributor = NavigationTracker;

export type NavigationEvent = NavigationEventInput;
export type RequestTree = RequestTreeNode[];
export type Generation = DocumentGeneration;
export type Snapshot = NavigationSnapshot;

export default NavigationTracker;
