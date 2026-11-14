import {
  parseContentDisposition,
  safeFilename,
  filenameMatches,
} from "./content-disposition.ts";
import { headerContentDisposition, headerContentType } from "./headers.ts";
import { buildActualFile, computeExpected, verifyFile } from "./integrity.ts";
import type { ActualFile } from "./integrity.ts";
import type {
  AttributionCandidate,
  BrowserCapture,
  DownloadAttribution,
  DownloadAttributorOptions,
  DownloadEvent,
  DownloadEventInput,
  EventId,
  FileCompletionInput,
  IgnoredEvent,
  NetworkResponse,
  NetworkResponseInput,
  Popup,
  PopupInput,
  PopupNavigationInput,
  RedirectHop,
  RedirectHopInput,
  ResolvedFileCompletion,
  UserAction,
  UserActionInput,
} from "./types.ts";
import {
  bestUrlMatch,
  firstHopAt,
  normalizeUrl,
  uniqueUrls,
} from "./url.ts";

interface Assessment {
  eligible: boolean;
  score: number;
  reasons: string[];
  rejections: string[];
  related: boolean;
}

interface ActionAssessment extends Assessment {
  action?: UserAction;
  popup?: Popup;
  blockedByTime: boolean;
}

interface ResponseAssessment extends Assessment {
  response: NetworkResponse;
  disposition?: ReturnType<typeof parseContentDisposition>;
}

interface PopupAssessment extends Assessment {
  popup?: Popup;
}

interface RecordState {
  downloadId: EventId;
  download?: DownloadEvent;
  responseKey?: EventId;
  response?: NetworkResponse;
  action?: UserAction;
  popup?: Popup;
  file?: ResolvedFileCompletion;
  actualFile?: ActualFile;
  verification?: ReturnType<typeof verifyFile>;
  claimScore: number;
  claimReasons: string[];
  createdAt: number;
  updatedAt: number;
  determinedAt?: number;
  finalizedAt?: number;
  revision: number;
  audit: IgnoredEvent[];
}

const DEFAULT_OPTIONS: Required<
  Omit<DownloadAttributorOptions, "now">
> & { now: () => number } = {
  now: () => Date.now(),
  clockSkewMs: 0,
  maxActionToResponseMs: 5 * 60_000,
  maxResponseToDownloadMs: 30 * 60_000,
  allowQuerylessUrlMatch: true,
  computeSha256: true,
  throwOnFileConflict: false,
  reuseResponseForMultipleDownloads: false,
  maxCandidates: 50,
};

export class AttributionConflictError extends Error {
  readonly downloadId: string;

  constructor(downloadId: string, message: string) {
    super(message);
    this.name = "AttributionConflictError";
    this.downloadId = downloadId;
  }
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function eventTime(input: {
  at?: number;
  timestamp?: number;
  timeStamp?: number;
  time?: number;
}, fallback: number): number {
  if (finite(input.at)) {
    return input.at;
  }
  if (finite(input.timestamp)) {
    return input.timestamp;
  }
  if (finite(input.timeStamp)) {
    return input.timeStamp;
  }
  if (finite(input.time)) {
    return input.time;
  }
  return fallback;
}

function sameId(left: unknown, right: unknown): boolean {
  return left !== undefined && right !== undefined && String(left) === String(right);
}

function maxDefined(...values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter(finite);
  return present.length > 0 ? Math.max(...present) : undefined;
}

function normalizeHop(hop: string | RedirectHopInput): RedirectHop {
  if (typeof hop === "string") {
    return { url: hop };
  }
  return {
    ...hop,
    url: hop.url,
    headers: hop.headers,
  };
}

function responseStart(response: NetworkResponse): number {
  return response.startedAt ?? firstHopAt(response.redirectChain) ?? response.at;
}

function responseUrls(response: NetworkResponse): string[] {
  return uniqueUrls(
    [
      response.finalUrl,
      response.url,
      ...response.redirectChain.map((hop) => hop.url),
    ],
    responseInitiator(response),
  );
}

function responseInitiator(response: NetworkResponse): string | undefined {
  return response.requestInitiator ?? response.initiatorUrl;
}

function downloadUrls(download: DownloadEvent | undefined): string[] {
  if (!download) {
    return [];
  }
  return uniqueUrls([download.finalUrl, download.url]);
}

function actionUrls(action: UserAction): string[] {
  return uniqueUrls(
    [action.url, action.targetUrl, ...action.urls],
    action.documentUrl ?? action.initiatorUrl,
  );
}

function actionInitiatorUrls(action: UserAction): string[] {
  return uniqueUrls(
    [...actionUrls(action), action.documentUrl, action.initiatorUrl],
    action.documentUrl ?? action.initiatorUrl,
  );
}

function popupUrls(popup: Popup): string[] {
  return uniqueUrls(
    [
      popup.url,
      ...popup.urls,
      ...popup.redirectChain.map((hop) => hop.url),
      popup.openerUrl,
    ],
    popup.openerUrl,
  );
}

function responseHeaders(response: NetworkResponse | undefined) {
  if (response?.headers) {
    return response.headers;
  }
  if (response) {
    for (let index = response.redirectChain.length - 1; index >= 0; index -= 1) {
      const headers = response.redirectChain[index]?.headers;
      if (headers) {
        return headers;
      }
    }
  }
  return undefined;
}

function observedDisposition(
  response: NetworkResponse | undefined,
  download?: DownloadEvent,
) {
  return parseContentDisposition(
    response?.contentDisposition ??
      headerContentDisposition(responseHeaders(response)) ??
      headerContentDisposition(download?.headers),
  );
}

function observedContentType(
  response: NetworkResponse | undefined,
  download?: DownloadEvent,
): string | undefined {
  const value =
    download?.mime ??
    download?.contentType ??
    response?.contentType ??
    headerContentType(responseHeaders(response)) ??
    headerContentType(download?.headers);
  return value?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

function scoreResponseForDownload(
  download: DownloadEvent,
  response: NetworkResponse,
  options: typeof DEFAULT_OPTIONS,
): ResponseAssessment {
  const reasons: string[] = [];
  const rejections: string[] = [];
  let score = 0;
  let explicit = false;
  let urlMatched = false;

  if (download.responseId) {
    if (sameId(download.responseId, response.id) || sameId(download.responseId, response.requestId)) {
      explicit = true;
      reasons.push("response-id");
      score += 100;
    } else {
      rejections.push("response-id-mismatch");
    }
  }

  if (download.requestId) {
    if (
      sameId(download.requestId, response.requestId) ||
      sameId(download.requestId, response.id)
    ) {
      explicit = true;
      reasons.push("request-id");
      score += 100;
    } else if (!download.responseId) {
      rejections.push("request-id-mismatch");
    }
  }

  if (response.downloadId) {
    if (sameId(response.downloadId, download.id)) {
      explicit = true;
      reasons.push("response-download-id");
      score += 100;
    } else {
      reasons.push("response-download-id-differs");
    }
  }

  if (downloadUrls(download).length > 0) {
    const match = bestUrlMatch(downloadUrls(download), responseUrls(response), {
      allowQueryless: options.allowQuerylessUrlMatch,
    });
    if (match) {
      urlMatched = true;
      reasons.push(match.kind === "exact" ? "url-exact" : "url-origin-path");
      score += match.kind === "exact" ? 50 : 35;
    } else if (!explicit) {
      rejections.push("url-mismatch");
    }
  } else if (!explicit) {
    rejections.push("download-url-missing");
  }

  if (!explicit && !urlMatched) {
    rejections.push("no-url-or-request-link");
  }

  const start = responseStart(response);
  if (start > download.at + options.clockSkewMs) {
    rejections.push("response-after-download");
  }
  if (download.at - start > options.maxResponseToDownloadMs) {
    rejections.push("response-download-window-exceeded");
  }

  if (finite(response.status) && response.status >= 400) {
    rejections.push(`http-status-${response.status}`);
  }

  if (download.tabId !== undefined && response.tabId !== undefined) {
    if (sameId(download.tabId, response.tabId)) {
      reasons.push("tab-match");
      score += 3;
    } else {
      reasons.push("tab-differs");
    }
  }
  if (download.windowId !== undefined && response.windowId !== undefined) {
    if (sameId(download.windowId, response.windowId)) {
      reasons.push("window-match");
      score += 2;
    } else {
      reasons.push("window-differs");
    }
  }

  const disposition = observedDisposition(response, download);
  if (disposition?.type === "attachment") {
    reasons.push("attachment");
    score += 4;
  }
  if (disposition?.filename) {
    if (filenameMatches(disposition.filename, download.filename)) {
      reasons.push("disposition-filename-match");
      score += 20;
    } else if (download.filename) {
      reasons.push("disposition-filename-differs");
    }
  }

  const contentType = observedContentType(response, download);
  if (download.mime && contentType && download.mime.toLowerCase() === contentType) {
    reasons.push("mime-match");
    score += 4;
  }

  const eligible = rejections.length === 0;
  return {
    response,
    disposition,
    eligible,
    score,
    reasons,
    rejections,
    related: urlMatched || explicit,
  };
}

function popupsForAction(popups: Iterable<Popup>, actionId: string): Popup[] {
  const result: Popup[] = [];
  for (const popup of popups) {
    if (sameId(popup.actionId, actionId) || sameId(popup.openerActionId, actionId)) {
      result.push(popup);
    }
  }
  return result;
}

function assessPopupForResponse(
  response: NetworkResponse,
  action: UserAction,
  popup: Popup,
  downloadAt: number | undefined,
  options: typeof DEFAULT_OPTIONS,
): PopupAssessment {
  const reasons: string[] = [];
  const rejections: string[] = [];
  let score = 0;

  const directPopup =
    response.popupId !== undefined && sameId(response.popupId, popup.id);
  const match = bestUrlMatch(
    popupUrls(popup),
    responseUrls(response),
    { allowQueryless: options.allowQuerylessUrlMatch },
  );
  const initiator = responseInitiator(response);
  const initiatorMatch = initiator
    ? bestUrlMatch(popupUrls(popup), [initiator], {
        allowQueryless: options.allowQuerylessUrlMatch,
      })
    : undefined;

  if (directPopup) {
    reasons.push("response-popup-id");
    score += 80;
  } else if (match) {
    reasons.push(match.kind === "exact" ? "popup-url-exact" : "popup-url-origin-path");
    score += match.kind === "exact" ? 45 : 30;
  } else if (initiatorMatch) {
    reasons.push("popup-initiator-url");
    score += 25;
  } else {
    rejections.push("popup-url-mismatch");
  }

  if (popup.at < action.at - options.clockSkewMs) {
    rejections.push("popup-before-action");
  }
  if (responseStart(response) < popup.at - options.clockSkewMs) {
    rejections.push("response-before-popup");
  }
  if (responseStart(response) - popup.at > options.maxActionToResponseMs) {
    rejections.push("popup-response-window-exceeded");
  }
  if (downloadAt !== undefined && downloadAt < popup.at - options.clockSkewMs) {
    rejections.push("download-before-popup");
  }

  return {
    popup,
    eligible: rejections.length === 0,
    score,
    reasons,
    rejections,
    related: directPopup || Boolean(match) || Boolean(initiatorMatch),
  };
}

function assessActionForResponse(
  response: NetworkResponse,
  action: UserAction,
  popups: Iterable<Popup>,
  downloadAt: number | undefined,
  options: typeof DEFAULT_OPTIONS,
): ActionAssessment {
  const popupList = [...popups];
  const reasons: string[] = [];
  const rejections: string[] = [];
  let score = 0;
  let related = false;
  let blockedByTime = false;
  let selectedPopup: Popup | undefined;

  const explicit =
    response.actionId !== undefined && sameId(response.actionId, action.id);
  if (explicit) {
    related = true;
    reasons.push("action-id");
    score += 100;
    if (response.popupId !== undefined) {
      for (const popup of popupList) {
        if (sameId(popup.id, response.popupId)) {
          selectedPopup = popup;
          reasons.push("response-popup-id");
          score += 10;
          break;
        }
      }
    }
  }

  if (!explicit) {
    const direct = bestUrlMatch(
      actionUrls(action),
      responseUrls(response),
      { allowQueryless: options.allowQuerylessUrlMatch },
    );
    if (direct) {
      related = true;
      reasons.push(direct.kind === "exact" ? "action-url-exact" : "action-url-origin-path");
      score += direct.kind === "exact" ? 45 : 32;
    }

    const initiator = responseInitiator(response);
    if (initiator) {
      const initiatorMatch = bestUrlMatch(
        actionInitiatorUrls(action),
        [initiator],
        { allowQueryless: options.allowQuerylessUrlMatch },
      );
      if (initiatorMatch) {
        related = true;
        reasons.push("initiator-url");
        score += 30;
      }
    }

    let bestPopup: PopupAssessment | undefined;
    for (const popup of popupsForAction(popupList, action.id)) {
      const assessment = assessPopupForResponse(
        response,
        action,
        popup,
        downloadAt,
        options,
      );
      if (
        assessment.eligible &&
        (!bestPopup || assessment.score > bestPopup.score)
      ) {
        bestPopup = assessment;
      }
    }
    if (bestPopup?.popup) {
      related = true;
      selectedPopup = bestPopup.popup;
      score += bestPopup.score;
      reasons.push(...bestPopup.reasons);
    }
  }

  if (!related) {
    rejections.push("action-url-mismatch");
  }

  const start = responseStart(response);
  if (start < action.at - options.clockSkewMs) {
    rejections.push("response-before-action");
    blockedByTime = true;
  }
  if (start - action.at > options.maxActionToResponseMs) {
    rejections.push("action-response-window-exceeded");
    blockedByTime = true;
  }
  if (downloadAt !== undefined && downloadAt < action.at - options.clockSkewMs) {
    rejections.push("download-before-action");
    blockedByTime = true;
  }

  if (action.tabId !== undefined && response.tabId !== undefined) {
    if (sameId(action.tabId, response.tabId)) {
      reasons.push("action-tab-match");
      score += 4;
    } else {
      reasons.push("action-tab-differs");
    }
  }
  if (action.windowId !== undefined && response.windowId !== undefined) {
    if (sameId(action.windowId, response.windowId)) {
      reasons.push("action-window-match");
      score += 2;
    }
  }

  return {
    action,
    popup: selectedPopup,
    eligible: rejections.length === 0 && related,
    score,
    reasons,
    rejections,
    related,
    blockedByTime,
  };
}

function bestActionForResponse(
  response: NetworkResponse,
  actions: Iterable<UserAction>,
  popups: Iterable<Popup>,
  downloadAt: number | undefined,
  options: typeof DEFAULT_OPTIONS,
): {
  best?: ActionAssessment;
  blocked: boolean;
  rejectedRelated: ActionAssessment[];
} {
  const popupList = [...popups];
  const rejectedRelated: ActionAssessment[] = [];
  let best: ActionAssessment | undefined;
  let blocked = false;

  for (const action of actions) {
    const assessment = assessActionForResponse(
      response,
      action,
      popupList,
      downloadAt,
      options,
    );
    if (assessment.eligible) {
      if (
        !best ||
        assessment.score > best.score ||
        (assessment.score === best.score &&
          (assessment.action?.at ?? 0) > (best.action?.at ?? 0))
      ) {
        best = assessment;
      }
    } else if (assessment.related) {
      rejectedRelated.push(assessment);
      if (assessment.blockedByTime) {
        blocked = true;
      }
    }
  }

  return { best, blocked, rejectedRelated };
}

function mergeResponse(
  existing: NetworkResponse,
  incoming: NetworkResponse,
): NetworkResponse {
  const chain = [...existing.redirectChain];
  for (const hop of incoming.redirectChain) {
    if (!chain.some((item) => normalizeUrl(item.url) === normalizeUrl(hop.url))) {
      chain.push(hop);
    }
  }
  const urls = uniqueUrls([...existing.urls, ...incoming.urls, ...chain.map((hop) => hop.url)]);
  return {
    ...existing,
    id: existing.id,
    requestId: existing.requestId,
    url: existing.url,
    finalUrl: existing.finalUrl ?? incoming.finalUrl,
    startedAt: existing.startedAt ?? incoming.startedAt,
    completedAt: maxDefined(existing.completedAt, incoming.completedAt),
    status: existing.status ?? incoming.status,
    headers: existing.headers ?? incoming.headers,
    contentDisposition:
      existing.contentDisposition ?? incoming.contentDisposition,
    contentType: existing.contentType ?? incoming.contentType,
    method: existing.method ?? incoming.method,
    resourceType: existing.resourceType ?? incoming.resourceType,
    tabId: existing.tabId ?? incoming.tabId,
    windowId: existing.windowId ?? incoming.windowId,
    frameId: existing.frameId ?? incoming.frameId,
    requestInitiator:
      existing.requestInitiator ?? incoming.requestInitiator,
    initiatorUrl: existing.initiatorUrl ?? incoming.initiatorUrl,
    actionId: existing.actionId ?? incoming.actionId,
    popupId: existing.popupId ?? incoming.popupId,
    downloadId: existing.downloadId ?? incoming.downloadId,
    metadata: existing.metadata ?? incoming.metadata,
    redirectChain: chain,
    urls,
  };
}

function mergeDownload(
  existing: DownloadEvent,
  incoming: DownloadEvent,
): DownloadEvent {
  const terminalStates = new Set([
    "completed",
    "complete",
    "interrupted",
    "cancelled",
    "canceled",
    "failed",
  ]);
  const state =
    existing.state === undefined
      ? incoming.state
      : terminalStates.has(existing.state) ||
          !incoming.state ||
          !terminalStates.has(incoming.state)
        ? existing.state
        : incoming.state;
  return {
    ...existing,
    requestId: existing.requestId ?? incoming.requestId,
    responseId: existing.responseId ?? incoming.responseId,
    url: existing.url ?? incoming.url,
    finalUrl: existing.finalUrl ?? incoming.finalUrl,
    filename: existing.filename ?? incoming.filename,
    suggestedFilename:
      existing.suggestedFilename ?? incoming.suggestedFilename,
    mime: existing.mime ?? incoming.mime,
    contentType: existing.contentType ?? incoming.contentType,
    totalBytes: existing.totalBytes ?? incoming.totalBytes,
    receivedBytes: maxDefined(existing.receivedBytes, incoming.receivedBytes),
    bytesReceived: maxDefined(existing.bytesReceived, incoming.bytesReceived),
    fileSize: existing.fileSize ?? incoming.fileSize,
    state,
    headers: existing.headers ?? incoming.headers,
    digest: existing.digest ?? incoming.digest,
    tabId: existing.tabId ?? incoming.tabId,
    windowId: existing.windowId ?? incoming.windowId,
    frameId: existing.frameId ?? incoming.frameId,
    metadata: existing.metadata ?? incoming.metadata,
  };
}

function downloadFieldConflicts(
  existing: DownloadEvent,
  incoming: DownloadEvent,
): string[] {
  const fields = [
    "requestId",
    "responseId",
    "url",
    "finalUrl",
    "filename",
    "mime",
    "contentType",
    "totalBytes",
    "fileSize",
  ] as const;
  const conflicts: string[] = [];
  for (const field of fields) {
    const left = existing[field];
    const right = incoming[field];
    if (left !== undefined && right !== undefined && String(left) !== String(right)) {
      conflicts.push(field);
    }
  }
  return conflicts;
}

function mergePopup(existing: Popup, incoming: Popup): Popup {
  const chain = [...existing.redirectChain];
  for (const hop of incoming.redirectChain) {
    if (!chain.some((item) => normalizeUrl(item.url) === normalizeUrl(hop.url))) {
      chain.push(hop);
    }
  }
  return {
    ...existing,
    actionId: existing.actionId ?? incoming.actionId,
    openerActionId: existing.openerActionId ?? incoming.openerActionId,
    url: existing.url ?? incoming.url,
    urls: uniqueUrls([...existing.urls, ...incoming.urls, ...chain.map((hop) => hop.url)]),
    redirectChain: chain,
    tabId: existing.tabId ?? incoming.tabId,
    windowId: existing.windowId ?? incoming.windowId,
    openerTabId: existing.openerTabId ?? incoming.openerTabId,
    openerUrl: existing.openerUrl ?? incoming.openerUrl,
    metadata: existing.metadata ?? incoming.metadata,
  };
}

function copyEvent<T extends object>(value: T): T {
  return { ...value } as T;
}

/**
 * Streaming attribution state machine for browser download events.
 *
 * The engine deliberately separates *observation* time from *arrival* order.
 * An older event that arrives late may fill a missing field, but it can never
 * replace a response claim or a completed file verification.
 */
export class DownloadAttributor {
  private readonly options: typeof DEFAULT_OPTIONS;
  private readonly actions = new Map<string, UserAction>();
  private readonly popups = new Map<string, Popup>();
  private readonly responses = new Map<string, NetworkResponse>();
  private readonly responseById = new Map<string, string>();
  private readonly records = new Map<string, RecordState>();
  private readonly recordAliases = new Map<string, string>();
  private readonly claims = new Map<string, string>();
  private arrival = 0;
  private autoId = 0;

  constructor(options: DownloadAttributorOptions = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      now: options.now ?? DEFAULT_OPTIONS.now,
    };
  }

  private nextArrival(): number {
    this.arrival += 1;
    return this.arrival;
  }

  private fallbackTime(): number {
    return this.options.now();
  }

  private nextId(prefix: string): string {
    this.autoId += 1;
    return `${prefix}:${this.autoId}`;
  }

  private normalizeAction(input: UserActionInput): UserAction {
    const urls = uniqueUrls(
      [input.url, input.targetUrl, ...(input.urls ?? [])],
      input.documentUrl ?? input.initiatorUrl,
    );
    return {
      ...input,
      id: String(input.id ?? input.actionId ?? this.nextId("action")),
      at: eventTime(input, this.fallbackTime()),
      kind: input.kind ?? "unknown",
      urls,
    };
  }

  private normalizePopup(input: PopupInput): Popup {
    const chain = (input.redirectChain ?? []).map(normalizeHop);
    return {
      ...input,
      id: String(input.id ?? input.popupId ?? this.nextId("popup")),
      at: eventTime(input, this.fallbackTime()),
      actionId: input.actionId ?? input.openerActionId,
      redirectChain: chain,
      urls: uniqueUrls(
        [
          input.url,
          ...(input.urls ?? []),
          ...chain.map((hop) => hop.url),
        ],
        input.openerUrl,
      ),
    };
  }

  private normalizeResponse(input: NetworkResponseInput): NetworkResponse {
    const chain = (input.redirectChain ?? []).map(normalizeHop);
    const requestId = String(
      input.requestId ??
        input.id ??
        input.responseId ??
        this.nextId("request"),
    );
    const id = String(input.id ?? input.responseId ?? requestId);
    return {
      ...input,
      id,
      requestId,
      at: eventTime(input, this.fallbackTime()),
      contentDisposition:
        input.contentDisposition ?? headerContentDisposition(input.headers),
      contentType: input.contentType ?? headerContentType(input.headers),
      requestInitiator: input.requestInitiator ?? input.initiatorUrl,
      redirectChain: chain,
      urls: uniqueUrls(
        [input.url, input.finalUrl, ...chain.map((hop) => hop.url)],
        input.requestInitiator ?? input.initiatorUrl,
      ),
    };
  }

  private normalizeDownload(input: DownloadEventInput): DownloadEvent {
    const id = String(
      input.id ??
        input.downloadId ??
        (input.requestId
          ? `download:${input.requestId}`
          : this.nextId("download")),
    );
    return {
      ...input,
      id,
      at: eventTime(input, this.fallbackTime()),
      filename: input.filename ?? input.suggestedFilename,
      mime: input.mime ?? input.contentType,
    };
  }

  private recordForDownload(
    downloadId: EventId,
    now: number,
  ): RecordState {
    const existing = this.records.get(downloadId);
    if (existing) {
      return existing;
    }
    const alias = this.recordAliases.get(String(downloadId));
    if (alias) {
      const aliased = this.records.get(alias);
      if (aliased) {
        return aliased;
      }
    }
    const created: RecordState = {
      downloadId,
      claimScore: 0,
      claimReasons: [],
      createdAt: now,
      updatedAt: now,
      revision: 1,
      audit: [],
    };
    this.records.set(downloadId, created);
    return created;
  }

  private audit(
    record: RecordState,
    kind: IgnoredEvent["kind"],
    id: string | undefined,
    reason: string,
    at: number | undefined,
    arrival: number,
  ): void {
    if (record.audit.length >= this.options.maxCandidates) {
      return;
    }
    record.audit.push({ kind, id, reason, at, arrival });
  }

  private findByResponseKey(responseKey: string): RecordState | undefined {
    for (const record of this.records.values()) {
      if (record.responseKey === responseKey) {
        return record;
      }
    }
    return undefined;
  }

  private findResponse(id: string): NetworkResponse | undefined {
    const direct = this.responses.get(id);
    if (direct) {
      return direct;
    }
    const key = this.responseById.get(id);
    return key ? this.responses.get(key) : undefined;
  }

  private storeResponse(response: NetworkResponse): NetworkResponse {
    const existing = this.responses.get(response.requestId);
    let stored = response;
    if (existing) {
      stored = mergeResponse(existing, response);
    }
    this.responses.set(stored.requestId, stored);
    this.responseById.set(stored.id, stored.requestId);
    this.responseById.set(response.id, stored.requestId);

    for (const record of this.records.values()) {
      if (record.responseKey === stored.requestId) {
        record.response = stored;
        if (!record.finalizedAt) {
          this.refreshVerification(record);
        }
      }
    }
    return stored;
  }

  private refreshVerification(record: RecordState): void {
    if (!record.actualFile) {
      return;
    }
    const expected = computeExpected(record.download, record.response);
    record.verification = {
      ...verifyFile(
        record.actualFile,
        expected.digests,
        expected.sizes,
        {
          now: this.options.now(),
          computeSha256: this.options.computeSha256,
        },
      ),
      path: record.file?.path,
      mime: record.file?.mime,
    };
  }

  private responseCandidatesForRecord(
    record: RecordState,
    onlyKey?: string,
  ): {
    selected?: {
      response: NetworkResponse;
      action?: ActionAssessment;
      totalScore: number;
    };
    assessments: Array<{
      assessment: ResponseAssessment;
      action?: ActionAssessment;
      claimedByOther: boolean;
    }>;
  } {
    if (!record.download) {
      return { assessments: [] };
    }

    const candidates: Array<{
      assessment: ResponseAssessment;
      action?: ActionAssessment;
      claimedByOther: boolean;
      totalScore: number;
    }> = [];

    const responses = onlyKey
      ? [this.responses.get(onlyKey)].filter(
          (response): response is NetworkResponse => Boolean(response),
        )
      : [...this.responses.values()];

    for (const response of responses) {
      const assessment = scoreResponseForDownload(
        record.download,
        response,
        this.options,
      );
      const actionResult = bestActionForResponse(
        response,
        this.actions.values(),
        this.popups.values(),
        record.download.at,
        this.options,
      );
      if (assessment.eligible && !actionResult.best && actionResult.blocked) {
        assessment.eligible = false;
        assessment.rejections.push("action-time-conflict");
      }
      if (assessment.eligible && actionResult.best) {
        assessment.reasons.push(...actionResult.best.reasons);
      }
      const claimedBy = this.claims.get(response.requestId);
      const claimedByOther = Boolean(
        claimedBy &&
          claimedBy !== record.downloadId &&
          !this.options.reuseResponseForMultipleDownloads,
      );
      if (claimedByOther) {
        assessment.eligible = false;
        assessment.rejections.push("response-already-claimed");
      }
      candidates.push({
        assessment,
        action: actionResult.best,
        claimedByOther,
        totalScore: assessment.score + (actionResult.best?.score ?? 0),
      });
    }

    candidates.sort((left, right) => {
      if (left.assessment.eligible !== right.assessment.eligible) {
        return left.assessment.eligible ? -1 : 1;
      }
      if (left.totalScore !== right.totalScore) {
        return right.totalScore - left.totalScore;
      }
      const leftStart = responseStart(left.assessment.response);
      const rightStart = responseStart(right.assessment.response);
      if (leftStart !== rightStart) {
        return rightStart - leftStart;
      }
      return String(left.assessment.response.requestId).localeCompare(
        String(right.assessment.response.requestId),
      );
    });

    const eligible = candidates.find((candidate) => candidate.assessment.eligible);
    return {
      selected: eligible
        ? {
            response: eligible.assessment.response,
            action: eligible.action,
            totalScore: eligible.totalScore,
          }
        : undefined,
      assessments: candidates.map((candidate) => ({
        assessment: candidate.assessment,
        action: candidate.action,
        claimedByOther: candidate.claimedByOther,
      })),
    };
  }

  private tryClaimResponse(record: RecordState, onlyKey?: string): boolean {
    if (record.response || !record.download) {
      return false;
    }
    const candidates = this.responseCandidatesForRecord(record, onlyKey);
    if (!candidates.selected) {
      return false;
    }

    const { response, action, totalScore } = candidates.selected;
    record.response = response;
    record.responseKey = response.requestId;
    record.action = action?.action;
    record.popup = action?.popup;
    record.claimScore = totalScore;
    record.claimReasons = [
      ...(candidates.assessments.find(
        (candidate) => candidate.assessment.response.requestId === response.requestId,
      )?.assessment.reasons ?? []),
      ...(action?.reasons ?? []),
    ];
    this.claims.set(response.requestId, record.downloadId);
    record.determinedAt = this.options.now();
    record.updatedAt = record.determinedAt;
    record.revision += 1;
    this.refreshVerification(record);
    return true;
  }

  private releaseClaim(record: RecordState): void {
    if (record.responseKey) {
      const claimedBy = this.claims.get(record.responseKey);
      if (claimedBy === record.downloadId) {
        this.claims.delete(record.responseKey);
      }
    }
    record.responseKey = undefined;
    record.response = undefined;
    record.action = undefined;
    record.popup = undefined;
    record.claimScore = 0;
    record.claimReasons = [];
    record.determinedAt = undefined;
    record.finalizedAt = undefined;
  }

  private validateExistingClaim(record: RecordState): boolean {
    if (!record.download || !record.response) {
      return true;
    }
    const assessment = scoreResponseForDownload(
      record.download,
      record.response,
      this.options,
    );
    if (!assessment.eligible) {
      if (!record.finalizedAt) {
        this.releaseClaim(record);
      }
      return false;
    }
    return true;
  }

  private finalize(record: RecordState): void {
    if (!record.response || !record.verification) {
      return;
    }
    if (record.finalizedAt === undefined) {
      record.finalizedAt = this.options.now();
      record.updatedAt = record.finalizedAt;
      record.revision += 1;
    }
  }

  private deriveState(record: RecordState): DownloadAttribution["state"] {
    if (!record.file) {
      return record.response ? "claimed" : "pending";
    }
    if (!record.response) {
      return "completed";
    }
    if (record.verification?.status === "verified") {
      return "verified";
    }
    if (record.verification?.status === "unverified") {
      return "completed";
    }
    return "failed";
  }

  private candidateForResponse(
    assessment: ResponseAssessment,
    record: RecordState,
  ): AttributionCandidate {
    const claimedBy = this.claims.get(assessment.response.requestId);
    return {
      target: "response",
      id: assessment.response.requestId,
      eligible: assessment.eligible,
      claimed: claimedBy === record.downloadId,
      score: assessment.score,
      reasons: assessment.reasons,
      rejections: assessment.rejections,
    };
  }

  private candidateForAction(
    assessment: ActionAssessment,
    record: RecordState,
  ): AttributionCandidate {
    return {
      target: "action",
      id: assessment.action?.id ?? "unknown",
      eligible: assessment.eligible,
      claimed: Boolean(
        assessment.action &&
          record.action &&
          sameId(assessment.action.id, record.action.id),
      ),
      score: assessment.score,
      reasons: assessment.reasons,
      rejections: assessment.rejections,
    };
  }

  private candidateForPopup(
    assessment: PopupAssessment,
    record: RecordState,
  ): AttributionCandidate {
    return {
      target: "popup",
      id: assessment.popup?.id ?? "unknown",
      eligible: assessment.eligible,
      claimed: Boolean(
        assessment.popup &&
          record.popup &&
          sameId(assessment.popup.id, record.popup.id),
      ),
      score: assessment.score,
      reasons: assessment.reasons,
      rejections: assessment.rejections,
    };
  }

  private buildCandidates(record: RecordState): AttributionCandidate[] {
    const result: AttributionCandidate[] = [];
    if (record.download && record.response) {
      const candidateSet = this.responseCandidatesForRecord(record);
      for (const candidate of candidateSet.assessments) {
        result.push(this.candidateForResponse(candidate.assessment, record));
      }
    } else if (record.download) {
      const candidateSet = this.responseCandidatesForRecord(record);
      for (const candidate of candidateSet.assessments) {
        result.push(this.candidateForResponse(candidate.assessment, record));
      }
    }

    if (record.response) {
      for (const action of this.actions.values()) {
        const assessment = assessActionForResponse(
          record.response,
          action,
          this.popups.values(),
          record.download?.at,
          this.options,
        );
        result.push(this.candidateForAction(assessment, record));
        for (const popup of popupsForAction(this.popups.values(), action.id)) {
          const popupAssessment = assessPopupForResponse(
            record.response,
            action,
            popup,
            record.download?.at,
            this.options,
          );
          result.push(this.candidateForPopup(popupAssessment, record));
        }
      }
    }

    result.sort((left, right) => {
      if (left.claimed !== right.claimed) {
        return left.claimed ? -1 : 1;
      }
      if (left.eligible !== right.eligible) {
        return left.eligible ? -1 : 1;
      }
      return right.score - left.score;
    });
    return result.slice(0, this.options.maxCandidates);
  }

  private snapshot(record: RecordState): DownloadAttribution {
    const disposition = observedDisposition(record.response, record.download);
    const download = record.download ? copyEvent(record.download) : undefined;
    const response = record.response ? copyEvent(record.response) : undefined;
    const action = record.action ? copyEvent(record.action) : undefined;
    const popup = record.popup ? copyEvent(record.popup) : undefined;
    const candidates = this.buildCandidates(record);
    const verification = record.verification;
    const state = this.deriveState(record);
    const determined = Boolean(record.response);
    const finalized = Boolean(record.response && record.file);

    return {
      downloadId: record.downloadId,
      state,
      determined,
      finalized,
      download,
      response,
      action,
      popup,
      requestId: record.response?.requestId ?? record.download?.requestId,
      matchedBy: [...record.claimReasons],
      confidence: Math.min(1, record.claimScore / 100),
      disposition,
      filename:
        safeFilename(record.download?.filename) ??
        safeFilename(disposition?.filename),
      mimeType:
        observedContentType(record.response, record.download) ??
        record.file?.mime,
      file: verification,
      verification,
      size: verification?.size ?? record.file?.size,
      sha256: verification?.sha256 ?? record.actualFile?.digests["sha-256"],
      verified: verification?.verified ?? false,
      candidates,
      ignored: [...record.audit].sort((left, right) => left.arrival - right.arrival),
      revision: record.revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      determinedAt: record.determinedAt,
      finalizedAt: record.finalizedAt,
    };
  }

  private gapFillAction(record: RecordState): void {
    if (!record.response || record.action || record.finalizedAt) {
      return;
    }
    const best = bestActionForResponse(
      record.response,
      this.actions.values(),
      this.popups.values(),
      record.download?.at,
      this.options,
    );
    if (best.best?.action) {
      record.action = best.best.action;
      record.popup = best.best.popup;
      record.claimScore = Math.max(record.claimScore, best.best.score + 30);
      record.claimReasons.push(
        ...best.best.reasons.filter(
          (reason) => !record.claimReasons.includes(reason),
        ),
      );
      record.updatedAt = this.options.now();
      record.revision += 1;
    }
  }

  recordAction(input: UserActionInput): UserAction {
    const action = this.normalizeAction(input);
    const existing = this.actions.get(action.id);
    if (existing) {
      const merged: UserAction = {
        ...existing,
        url: existing.url ?? action.url,
        targetUrl: existing.targetUrl ?? action.targetUrl,
        documentUrl: existing.documentUrl ?? action.documentUrl,
        initiatorUrl: existing.initiatorUrl ?? action.initiatorUrl,
        tabId: existing.tabId ?? action.tabId,
        windowId: existing.windowId ?? action.windowId,
        frameId: existing.frameId ?? action.frameId,
        metadata: existing.metadata ?? action.metadata,
        urls: uniqueUrls([...existing.urls, ...action.urls]),
      };
      this.actions.set(action.id, merged);
      for (const record of this.records.values()) {
        if (!record.finalizedAt) {
          this.gapFillAction(record);
        }
      }
      return copyEvent(merged);
    }

    this.actions.set(action.id, action);
    for (const record of this.records.values()) {
      if (record.finalizedAt) {
        continue;
      }
      this.gapFillAction(record);
    }
    return copyEvent(action);
  }

  recordPopup(input: PopupInput): Popup {
    const popup = this.normalizePopup(input);
    const existing = this.popups.get(popup.id);
    const merged = existing ? mergePopup(existing, popup) : popup;
    this.popups.set(popup.id, merged);

    for (const record of this.records.values()) {
      if (record.finalizedAt) {
        continue;
      }
      if (record.response && !record.action) {
        this.gapFillAction(record);
      }
    }
    return copyEvent(merged);
  }

  recordPopupNavigation(
    popupId: EventId,
    input: PopupNavigationInput,
  ): Popup | undefined {
    const popup = this.popups.get(String(popupId));
    if (!popup) {
      return undefined;
    }
    const hop: RedirectHop = {
      url: input.url,
      at: eventTime(input, this.fallbackTime()),
      status: input.status,
      headers: input.headers,
    };
    const merged: Popup = {
      ...popup,
      urls: uniqueUrls([...popup.urls, input.url]),
      redirectChain: [...popup.redirectChain, hop],
    };
    this.popups.set(popup.id, merged);
    for (const record of this.records.values()) {
      if (!record.finalizedAt && record.response && !record.action) {
        this.gapFillAction(record);
      }
    }
    return copyEvent(merged);
  }

  recordResponse(input: NetworkResponseInput): NetworkResponse {
    const incoming = this.normalizeResponse(input);
    const stored = this.storeResponse(incoming);
    const arrival = this.nextArrival();

    if (stored.downloadId) {
      const record = this.recordForDownload(String(stored.downloadId), this.options.now());
      const claimedBy = this.claims.get(stored.requestId);
      if (claimedBy && claimedBy !== record.downloadId) {
        this.audit(
          record,
          "response",
          stored.requestId,
          "late-response-ignored: response already claimed by another download",
          stored.at,
          arrival,
        );
      } else if (!record.download) {
        // The download event normally follows the response; keep the claim
        // pending until its URL/time evidence exists.
        record.response = stored;
        record.responseKey = stored.requestId;
        this.claims.set(stored.requestId, record.downloadId);
        record.claimScore = 100;
        record.claimReasons = ["response-download-id"];
        record.determinedAt = this.options.now();
        record.updatedAt = record.determinedAt;
        record.revision += 1;
      } else {
        this.tryClaimResponse(record, stored.requestId);
      }
      if (record.file && !record.finalizedAt) {
        this.refreshVerification(record);
        this.finalize(record);
      }
    }

    for (const record of this.records.values()) {
      if (!record.download) {
        continue;
      }
      if (!record.response) {
        const claimed = this.tryClaimResponse(record);
        if (claimed && record.file) {
          this.finalize(record);
        }
        continue;
      }

      if (record.responseKey === stored.requestId) {
        continue;
      }

      const explicitConflict =
        (record.download.requestId !== undefined &&
          sameId(record.download.requestId, stored.requestId)) ||
        (record.download.responseId !== undefined &&
          (sameId(record.download.responseId, stored.id) ||
            sameId(record.download.responseId, stored.requestId)));
      if (explicitConflict) {
        this.audit(
          record,
          "response",
          stored.requestId,
          record.finalizedAt
            ? "late-response-ignored: result finalized"
            : "late-response-ignored: response already claimed",
          stored.at,
          arrival,
        );
        continue;
      }

      const assessment = scoreResponseForDownload(
        record.download,
        stored,
        this.options,
      );
      if (assessment.eligible) {
        this.audit(
          record,
          "response",
          stored.requestId,
          "late-response-ignored: result already determined",
          stored.at,
          arrival,
        );
      }
    }

    return copyEvent(stored);
  }

  recordDownload(input: DownloadEventInput): DownloadAttribution {
    const download = this.normalizeDownload(input);
    const now = this.options.now();
    let record = this.records.get(download.id);

    if (!record && download.requestId) {
      const existing = this.findByResponseKey(String(download.requestId));
      if (
        existing &&
        (!existing.download || !this.options.reuseResponseForMultipleDownloads)
      ) {
        record = existing;
      }
      if (!record) {
        const response = this.findResponse(String(download.requestId));
        if (response) {
          const byResponse = this.findByResponseKey(response.requestId);
          if (
            byResponse &&
            (!byResponse.download ||
              !this.options.reuseResponseForMultipleDownloads)
          ) {
            record = byResponse;
          }
        }
      }
    }
    if (!record && download.responseId) {
      const response = this.findResponse(String(download.responseId));
      if (response) {
        const existing = this.findByResponseKey(response.requestId);
        if (
          existing &&
          (!existing.download || !this.options.reuseResponseForMultipleDownloads)
        ) {
          record = existing;
        }
      }
    }

    if (!record) {
      record = this.recordForDownload(download.id, now);
    }

    if (record.download && record.downloadId !== download.id) {
      this.recordAliases.set(download.id, record.downloadId);
      this.audit(
        record,
        "download",
        download.id,
        "duplicate-download-id-mapped-to-existing-record",
        download.at,
        this.nextArrival(),
      );
      return this.snapshot(record);
    }

    if (record.downloadId !== download.id) {
      const previousId = record.downloadId;
      this.records.delete(previousId);
      this.recordAliases.set(previousId, download.id);
      record.downloadId = download.id;
      this.records.set(download.id, record);
      for (const [responseKey, downloadId] of this.claims) {
        if (downloadId === previousId) {
          this.claims.set(responseKey, download.id);
        }
      }
    }

    if (record.download) {
      const conflicts = downloadFieldConflicts(record.download, download);
      record.download = mergeDownload(record.download, download);
      if (conflicts.length > 0) {
        this.audit(
          record,
          "download",
          download.id,
          `late-download-ignored-fields: ${conflicts.join(", ")}`,
          download.at,
          this.nextArrival(),
        );
      }
    } else {
      record.download = download;
      record.updatedAt = now;
      record.revision += 1;
    }

    if (record.response && !record.finalizedAt) {
      this.validateExistingClaim(record);
    }

    if (!record.response) {
      this.tryClaimResponse(record);
    }
    if (record.response && !record.action && !record.finalizedAt) {
      this.gapFillAction(record);
    }
    if (record.file && !record.finalizedAt) {
      this.refreshVerification(record);
    }
    this.finalize(record);
    return this.snapshot(record);
  }

  private resolveFileRecord(input: FileCompletionInput): RecordState | undefined {
    const now = this.options.now();
    if (input.downloadId !== undefined) {
      return this.recordForDownload(String(input.downloadId), now);
    }

    let response: NetworkResponse | undefined;
    if (input.responseId !== undefined) {
      response = this.findResponse(String(input.responseId));
    }
    if (!response && input.requestId !== undefined) {
      response = this.findResponse(String(input.requestId));
    }
    if (response) {
      const claimed = this.claims.get(response.requestId);
      if (claimed) {
        return this.records.get(claimed);
      }
      if (response.downloadId !== undefined) {
        return this.recordForDownload(String(response.downloadId), now);
      }
      const key = `response:${response.requestId}`;
      const record = this.recordForDownload(key, now);
      record.response = response;
      record.responseKey = response.requestId;
      this.claims.set(response.requestId, key);
      record.claimScore = 100;
      record.claimReasons = ["file-response-id"];
      record.determinedAt = now;
      record.updatedAt = now;
      record.revision += 1;
      return record;
    }

    if (input.requestId !== undefined) {
      for (const record of this.records.values()) {
        if (
          record.download &&
          sameId(record.download.requestId, input.requestId)
        ) {
          return record;
        }
      }
    }
    return undefined;
  }

  async recordFile(input: FileCompletionInput): Promise<DownloadAttribution> {
    const now = this.options.now();
    const record = this.resolveFileRecord(input);
    if (!record) {
      throw new Error(
        "File completion must reference a known downloadId, responseId, or requestId",
      );
    }

    const actual = await buildActualFile({
      bytes: input.bytes,
      content: input.content,
      size: input.size,
      sha256: input.sha256,
      digest: input.digest,
      digests: input.digests,
      algorithms: computeExpected(record.download, record.response).digests.map(
        (digest) => digest.algorithm,
      ),
      computeSha256: this.options.computeSha256,
    });

    const completion: ResolvedFileCompletion = {
      downloadId: input.downloadId,
      responseId: input.responseId,
      requestId: input.requestId,
      at: eventTime(input, now),
      size: actual.size,
      digests: { ...actual.digests },
      path: input.path,
      mime: input.mime,
      metadata: input.metadata,
    };

    if (record.file) {
      const sameSize = record.file.size === actual.size;
      const overlapping = Object.keys(actual.digests).filter(
        (algorithm) => record.file!.digests[algorithm] !== undefined,
      );
      const sameDigests = overlapping.every(
        (algorithm) =>
          record.file!.digests[algorithm]?.toLowerCase() ===
          actual.digests[algorithm]?.toLowerCase(),
      );
      const identical = sameSize && sameDigests;
      if (identical) {
        return this.snapshot(record);
      }
      if (this.options.throwOnFileConflict) {
        throw new AttributionConflictError(
          record.downloadId,
          `Conflicting file completion for ${record.downloadId}: ` +
            `existing ${record.file.size} bytes, received ${actual.size} bytes`,
        );
      }
      this.audit(
        record,
        "file",
        record.downloadId,
        "late-file-ignored: result already has a completed file",
        completion.at,
        this.nextArrival(),
      );
      return this.snapshot(record);
    }

    record.file = completion;
    record.actualFile = actual;
    record.updatedAt = now;
    record.revision += 1;
    this.refreshVerification(record);

    if (!record.response) {
      this.tryClaimResponse(record);
    }
    if (record.response && !record.action && !record.finalizedAt) {
      this.gapFillAction(record);
    }
    this.finalize(record);
    return this.snapshot(record);
  }

  get(downloadId: EventId): DownloadAttribution | undefined {
    const key = String(downloadId);
    const record = this.records.get(key) ?? this.records.get(
      this.recordAliases.get(key) ?? "\u0000",
    );
    return record ? this.snapshot(record) : undefined;
  }

  getAttribution(downloadId: EventId): DownloadAttribution | undefined {
    return this.get(downloadId);
  }

  require(downloadId: EventId): DownloadAttribution {
    const result = this.get(downloadId);
    if (!result) {
      throw new Error(`Unknown download: ${downloadId}`);
    }
    return result;
  }

  list(): DownloadAttribution[] {
    return [...this.records.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => this.snapshot(record));
  }

  attributionsForAction(actionId: EventId): DownloadAttribution[] {
    return this.list().filter(
      (result) => result.action && sameId(result.action.id, actionId),
    );
  }

  /**
   * Returns every response that is URL/time compatible with an action. This is
   * the candidate list before a download claims one of them.
   */
  candidatesForAction(actionId: EventId): AttributionCandidate[] {
    const action = this.actions.get(String(actionId));
    if (!action) {
      return [];
    }
    const candidates: AttributionCandidate[] = [];
    for (const response of this.responses.values()) {
      const assessment = assessActionForResponse(
        response,
        action,
        this.popups.values(),
        undefined,
        this.options,
      );
      candidates.push({
        target: "response",
        id: response.requestId,
        eligible: assessment.eligible,
        claimed: this.claims.has(response.requestId),
        score: assessment.score,
        reasons: assessment.reasons,
        rejections: assessment.rejections,
      });
    }
    candidates.sort((left, right) => {
      if (left.eligible !== right.eligible) {
        return left.eligible ? -1 : 1;
      }
      return right.score - left.score;
    });
    return candidates.slice(0, this.options.maxCandidates);
  }

  candidatesForDownload(downloadId: EventId): AttributionCandidate[] {
    const key = String(downloadId);
    const record =
      this.records.get(key) ??
      this.records.get(this.recordAliases.get(key) ?? "\u0000");
    if (!record) {
      return [];
    }
    return this.buildCandidates(record).filter(
      (candidate) => candidate.target === "response",
    );
  }

  async ingest(event: BrowserCapture): Promise<DownloadAttribution | undefined> {
    switch (event.type) {
      case "action":
        this.recordAction(event);
        return undefined;
      case "popup":
        this.recordPopup(event);
        return undefined;
      case "response":
        this.recordResponse(event);
        return undefined;
      case "download":
        return this.recordDownload(event);
      case "file":
        return this.recordFile(event);
      case "popup-navigation": {
        const { popupId, ...navigation } = event;
        this.recordPopupNavigation(popupId, navigation);
        return undefined;
      }
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  reset(): void {
    this.actions.clear();
    this.popups.clear();
    this.responses.clear();
    this.responseById.clear();
    this.records.clear();
    this.recordAliases.clear();
    this.claims.clear();
    this.arrival = 0;
    this.autoId = 0;
  }
}

export { DownloadAttributor as DownloadAttributionEngine };
