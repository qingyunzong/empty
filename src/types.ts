export type EventId = string;
export type BrowserId = string | number;

export interface TimingInput {
  /** Epoch milliseconds, or any monotonic clock shared by all events. */
  at?: number;
  /** Alias commonly used by browser performance/event records. */
  timestamp?: number;
  /** Alias used by DOM events. */
  timeStamp?: number;
  /** Generic alias used by extension message envelopes. */
  time?: number;
  /** Optional insertion order used to break ties at identical timestamps. */
  sequence?: number;
}

export interface Timing extends TimingInput {
  at: number;
}

export type HeaderSource =
  | Headers
  | Map<string, string | readonly string[]>
  | Iterable<readonly [string, string]>
  | Record<string, string | readonly string[] | number | null | undefined>;

export interface RedirectHopInput {
  url: string;
  at?: number;
  status?: number;
  headers?: HeaderSource;
}

export interface RedirectHop extends RedirectHopInput {
  url: string;
}

export interface ParsedContentDisposition {
  type: string;
  filename?: string;
  filenameStar?: string;
  parameters: Record<string, string>;
}

export interface DigestSpec {
  algorithm: string;
  value: string;
}

export type DigestInput = DigestSpec | string;

export interface UserActionInput extends TimingInput {
  id?: EventId;
  actionId?: EventId;
  kind?: string;
  /** URL activated by the user (usually an anchor href). */
  url?: string;
  /** Alias for url used by popup/navigation adapters. */
  targetUrl?: string;
  /** Additional URLs that can describe the activated link. */
  urls?: readonly string[];
  /** Document URL on which the action happened. */
  documentUrl?: string;
  initiatorUrl?: string;
  tabId?: BrowserId;
  windowId?: BrowserId;
  frameId?: BrowserId;
  metadata?: Readonly<Record<string, unknown>>;
}

export type UserAction = Omit<UserActionInput, "at"> &
  Timing & {
    id: EventId;
    urls: readonly string[];
  };

export interface PopupInput extends TimingInput {
  id?: EventId;
  popupId?: EventId;
  actionId?: EventId;
  openerActionId?: EventId;
  url?: string;
  urls?: readonly string[];
  redirectChain?: readonly (string | RedirectHopInput)[];
  tabId?: BrowserId;
  windowId?: BrowserId;
  openerTabId?: BrowserId;
  openerUrl?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export type Popup = Omit<PopupInput, "at" | "redirectChain"> &
  Timing & {
    id: EventId;
    urls: readonly string[];
    redirectChain: readonly RedirectHop[];
    actionId?: EventId;
  };

export interface PopupNavigationInput extends TimingInput {
  url: string;
  status?: number;
  headers?: HeaderSource;
}

export interface NetworkResponseInput extends TimingInput {
  id?: EventId;
  responseId?: EventId;
  requestId?: EventId;
  url: string;
  finalUrl?: string;
  /**
   * When response headers/first byte became observable. Prefer the
   * onHeadersReceived/onResponseStarted timestamp; put body completion in
   * completedAt so a download event created before body completion still
   * satisfies the causal order.
   */
  at?: number;
  /** Time the request/redirect chain started. */
  startedAt?: number;
  /** Time the response body completed, when the collector knows it. */
  completedAt?: number;
  redirectChain?: readonly (string | RedirectHopInput)[];
  status?: number;
  headers?: HeaderSource;
  contentDisposition?: string;
  contentType?: string;
  method?: string;
  resourceType?: string;
  tabId?: BrowserId;
  windowId?: BrowserId;
  frameId?: BrowserId;
  /** Document/frame that initiated the request. */
  requestInitiator?: string;
  initiatorUrl?: string;
  actionId?: EventId;
  popupId?: EventId;
  downloadId?: EventId;
  metadata?: Readonly<Record<string, unknown>>;
}

export type NetworkResponse = Omit<NetworkResponseInput, "at" | "redirectChain"> &
  Timing & {
    id: EventId;
    requestId: EventId;
    redirectChain: readonly RedirectHop[];
    urls: readonly string[];
  };

export interface DownloadEventInput extends TimingInput {
  id?: EventId;
  downloadId?: EventId;
  requestId?: EventId;
  responseId?: EventId;
  url?: string;
  finalUrl?: string;
  filename?: string;
  suggestedFilename?: string;
  mime?: string;
  contentType?: string;
  totalBytes?: number;
  receivedBytes?: number;
  bytesReceived?: number;
  fileSize?: number;
  state?: "in-progress" | "completed" | "interrupted" | "cancelled" | string;
  headers?: HeaderSource;
  digest?: DigestInput;
  tabId?: BrowserId;
  windowId?: BrowserId;
  frameId?: BrowserId;
  metadata?: Readonly<Record<string, unknown>>;
}

export type DownloadEvent = Omit<DownloadEventInput, "at"> &
  Timing & {
    id: EventId;
  };

export type FileBytes = ArrayBuffer | ArrayBufferView;

export interface FileCompletionInput extends TimingInput {
  downloadId?: EventId;
  responseId?: EventId;
  requestId?: EventId;
  /** Number of bytes written to disk. */
  size?: number;
  /** File bytes, used to compute the digest when no digest is supplied. */
  bytes?: FileBytes;
  /** Literal file contents. UTF-8 is used for hashing. */
  content?: string;
  /** Pre-computed SHA-256 digest, decimal/hex/base64 encoded. */
  sha256?: string;
  /** Pre-computed digest. */
  digest?: DigestInput;
  /** Several pre-computed digests. */
  digests?: readonly DigestSpec[] | Readonly<Record<string, string>>;
  path?: string;
  mime?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export type ResolvedFileCompletion = Timing & {
  downloadId?: EventId;
  responseId?: EventId;
  requestId?: EventId;
  size: number;
  digests: Readonly<Record<string, string>>;
  path?: string;
  mime?: string;
  metadata?: Readonly<Record<string, unknown>>;
};

export type VerificationStatus =
  | "verified"
  | "size-mismatch"
  | "digest-mismatch"
  | "mismatch"
  | "unverified";

export interface FileVerification {
  status: VerificationStatus;
  verified: boolean;
  size: number;
  path?: string;
  mime?: string;
  /** Lower-case hex digests keyed by canonical algorithm name. */
  digests: Readonly<Record<string, string>>;
  sha256?: string;
  expectedSize?: number;
  declaredSizes: readonly number[];
  expectedDigests: readonly DigestSpec[];
  sizeMatches?: boolean;
  digestMatches: Readonly<Record<string, boolean>>;
  reasons: readonly string[];
  checkedAt: number;
}

export type AttributionState =
  | "pending"
  | "claimed"
  | "completed"
  | "verified"
  | "failed";

export type CandidateTarget = "response" | "action" | "popup";

export interface AttributionCandidate {
  target: CandidateTarget;
  id: string;
  eligible: boolean;
  claimed: boolean;
  score: number;
  reasons: readonly string[];
  rejections: readonly string[];
}

export type IgnoredEventKind =
  | "action"
  | "popup"
  | "response"
  | "download"
  | "file";

export interface IgnoredEvent {
  kind: IgnoredEventKind;
  id?: string;
  reason: string;
  at?: number;
  arrival: number;
}

export interface DownloadAttribution {
  downloadId: EventId;
  state: AttributionState;
  /** True once a response has been irrevocably claimed. */
  determined: boolean;
  /** True once both the response claim and on-disk file are final. */
  finalized: boolean;
  download?: DownloadEvent;
  response?: NetworkResponse;
  action?: UserAction;
  popup?: Popup;
  requestId?: string;
  matchedBy: readonly string[];
  confidence: number;
  disposition?: ParsedContentDisposition;
  filename?: string;
  mimeType?: string;
  file?: FileVerification;
  verification?: FileVerification;
  size?: number;
  sha256?: string;
  verified: boolean;
  candidates: readonly AttributionCandidate[];
  ignored: readonly IgnoredEvent[];
  revision: number;
  createdAt: number;
  updatedAt: number;
  determinedAt?: number;
  finalizedAt?: number;
}

export interface UrlMatch {
  kind: "exact" | "origin-path";
  target: string;
  candidate: string;
  score: number;
}

export interface DownloadAttributorOptions {
  now?: () => number;
  /** Tolerance for timestamps from different browser clocks. Default: 0. */
  clockSkewMs?: number;
  /** Maximum action-to-response delay. Default: 5 minutes. */
  maxActionToResponseMs?: number;
  /** Maximum response-start-to-download delay. Default: 30 minutes. */
  maxResponseToDownloadMs?: number;
  /** Allow origin+path matching when query strings differ. Default: true. */
  allowQuerylessUrlMatch?: boolean;
  /** Compute SHA-256 when file bytes are supplied. Default: true. */
  computeSha256?: boolean;
  /** Reject a conflicting second file completion instead of ignoring it. */
  throwOnFileConflict?: boolean;
  /** Let one response be claimed by more than one download record. */
  reuseResponseForMultipleDownloads?: boolean;
  /** Maximum candidates retained in a snapshot. Default: 50. */
  maxCandidates?: number;
}

export interface BrowserCaptureEvent {
  type: "action" | "popup" | "response" | "download" | "file" | "popup-navigation";
}

export type UserActionCapture = UserActionInput & { type: "action" };
export type PopupCapture = PopupInput & { type: "popup" };
export type ResponseCapture = NetworkResponseInput & { type: "response" };
export type DownloadCapture = DownloadEventInput & { type: "download" };
export type FileCapture = FileCompletionInput & { type: "file" };
export type PopupNavigationCapture = PopupNavigationInput & {
  type: "popup-navigation";
  popupId: EventId;
};

export type BrowserCapture =
  | UserActionCapture
  | PopupCapture
  | ResponseCapture
  | DownloadCapture
  | FileCapture
  | PopupNavigationCapture;
