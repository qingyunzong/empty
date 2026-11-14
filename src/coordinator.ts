import { normalizePolicy, type NormalizedPolicy } from "./policy.js";
import type {
  AuthCallbackEvent,
  CoordinatorSnapshot,
  EvidenceCode,
  EvidenceRecord,
  IdpCandidate,
  IdpChoiceEvent,
  IdpSelectedEvent,
  IsolationCode,
  MfaChallengeEvent,
  MfaCompletedEvent,
  NavigationEvent,
  NextAction,
  PageActivatedEvent,
  PageIdentity,
  Phase,
  SsoEvent,
  SsoLoginPolicy,
} from "./types.js";
import { parseTopLevelUrl, type ParsedUrl } from "./url.js";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const LABEL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const STATE_ENCODER = new TextEncoder();

type EvidenceDetails = Omit<
  EvidenceRecord,
  "seq" | "at" | "code" | "phase" | "message"
>;

interface PageOk {
  readonly ok: true;
  readonly page: PageIdentity;
}

interface PageError {
  readonly ok: false;
  readonly message: string;
}

type PageResult = PageOk | PageError;

interface CheckOk<T> {
  readonly ok: true;
  readonly value: T;
}

interface CheckError {
  readonly ok: false;
  readonly code: IsolationCode;
  readonly message: string;
}

type CheckResult<T> = CheckOk<T> | CheckError;

interface IssuerMatch {
  readonly issuer: string | null;
  readonly allowed: boolean;
}

interface StateMatch {
  readonly present: boolean;
  readonly matched: boolean;
}

interface PreparedCandidates {
  readonly candidates: readonly IdpCandidate[];
  readonly byId: ReadonlyMap<string, IdpCandidate>;
  readonly rejectedIds: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = STATE_ENCODER.encode(left);
  const b = STATE_ENCODER.encode(right);
  const length = Math.max(a.length, b.length, 1);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function validatePage(raw: unknown): PageResult {
  if (!isRecord(raw)) {
    return { ok: false, message: "page identity must be an object" };
  }

  const tabId = raw.tabId;
  const generation = raw.generation;
  if (
    typeof tabId !== "string" ||
    tabId.length === 0 ||
    tabId.length > 256 ||
    CONTROL_CHARACTERS.test(tabId)
  ) {
    return { ok: false, message: "page.tabId must be a non-empty printable string" };
  }
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  ) {
    return { ok: false, message: "page.generation must be a non-negative safe integer" };
  }

  return {
    ok: true,
    page: Object.freeze({ tabId, generation }),
  };
}

function sanitizeLabel(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") {
    return fallback;
  }
  const label = raw.replace(LABEL_CONTROL_CHARACTERS, " ").trim().slice(0, 160);
  return label === "" ? fallback : label;
}

function prepareCandidates(
  raw: unknown,
  allowedIssuers: ReadonlyMap<string, string>,
): PreparedCandidates | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) {
    return null;
  }

  const candidates: IdpCandidate[] = [];
  const byId = new Map<string, IdpCandidate>();
  const rejectedIds: string[] = [];
  const seenIds = new Set<string>();

  for (const item of raw) {
    if (!isRecord(item)) {
      return null;
    }
    const rawId = item.id;
    if (
      typeof rawId !== "string" ||
      rawId.length === 0 ||
      rawId.length > 128 ||
      CONTROL_CHARACTERS.test(rawId) ||
      seenIds.has(rawId)
    ) {
      return null;
    }
    seenIds.add(rawId);

    const rawIssuer = item.issuer;
    if (typeof rawIssuer !== "string" || !allowedIssuers.has(rawIssuer)) {
      rejectedIds.push(rawId);
      continue;
    }

    const candidate: IdpCandidate = Object.freeze({
      id: rawId,
      displayName: sanitizeLabel(item.displayName, rawId),
      issuer: rawIssuer,
    });
    candidates.push(candidate);
    byId.set(rawId, candidate);
  }

  return {
    candidates: Object.freeze(candidates),
    byId,
    rejectedIds: Object.freeze(rejectedIds),
  };
}

function prepareMethods(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) {
    return null;
  }

  const methods: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") {
      return null;
    }
    const method = item.trim().slice(0, 64);
    if (method === "" || CONTROL_CHARACTERS.test(method)) {
      return null;
    }
    if (!seen.has(method)) {
      seen.add(method);
      methods.push(method);
    }
  }

  return methods.length === 0 ? null : Object.freeze(methods);
}

export class SsoLoginCoordinator {
  private readonly policy: NormalizedPolicy;
  private currentPhase: Phase;
  private currentAction: NextAction;
  private currentPage: PageIdentity | null;
  private readonly ledger: EvidenceRecord[];
  private sequence: number;
  private idpCandidates: ReadonlyMap<string, IdpCandidate>;
  private selectedIdpId: string | null;

  constructor(policy: SsoLoginPolicy) {
    this.policy = normalizePolicy(policy);
    this.currentPhase = "idle";
    this.currentAction = Object.freeze({ type: "begin" });
    this.currentPage = null;
    this.ledger = [];
    this.sequence = 0;
    this.idpCandidates = new Map();
    this.selectedIdpId = null;
  }

  get phase(): Phase {
    return this.currentPhase;
  }

  begin(page: PageIdentity, entryUrl: string): CoordinatorSnapshot {
    if (this.currentPhase !== "idle") {
      return this.isolate(
        "ALREADY_STARTED",
        "begin() may only be called once per coordinator",
      );
    }

    const pageResult = validatePage(page);
    if (!pageResult.ok) {
      return this.isolate("INVALID_PAGE", pageResult.message);
    }

    const parsed = parseTopLevelUrl(entryUrl);
    if (parsed === null) {
      return this.isolate(
        "INVALID_URL",
        "entry URL must be a secure absolute HTTP(S) URL without credentials",
        this.pageDetails(pageResult.page),
      );
    }
    if (!this.policy.applicationOrigins.has(parsed.url.origin)) {
      return this.isolate(
        "UNEXPECTED_ORIGIN",
        "entry URL origin is not an allowed application origin",
        { ...this.pageDetails(pageResult.page), url: parsed.safe },
      );
    }

    this.currentPage = pageResult.page;
    this.currentPhase = "navigating";
    this.setAction({ type: "wait_for_redirect" });
    this.append("FLOW_STARTED", "login flow started", {
      ...this.pageDetails(pageResult.page),
      url: parsed.safe,
    });
    return this.snapshot();
  }

  dispatch(event: SsoEvent): CoordinatorSnapshot {
    try {
      return this.processEvent(event);
    } catch {
      return this.isolate(
        "INVALID_EVENT",
        "event processing failed closed",
      );
    }
  }

  private processEvent(event: SsoEvent): CoordinatorSnapshot {
    if (this.currentPhase === "isolated") {
      return this.snapshot();
    }
    if (this.currentPhase === "completed") {
      return this.isolate(
        "POST_COMPLETION_ACTIVITY",
        "event received after login completion",
        this.eventContext(event),
      );
    }
    if (!isRecord(event) || typeof event.type !== "string") {
      return this.isolate("INVALID_EVENT", "event must be an object with a type");
    }
    if (this.currentPhase === "idle") {
      return this.isolate(
        "UNEXPECTED_PROTOCOL_EVENT",
        "begin() must be called before dispatching navigation events",
        this.eventContext(event),
      );
    }

    const pageResult = validatePage(event.page);
    if (!pageResult.ok) {
      return this.isolate("INVALID_PAGE", pageResult.message, this.eventContext(event));
    }

    const page = pageResult.page;
    const current = this.currentPage;
    if (current === null) {
      return this.isolate("INVALID_PAGE", "coordinator has no active page");
    }
    if (page.tabId !== current.tabId) {
      return this.isolate(
        "FOREIGN_TAB",
        "event originated from a tab outside the bound login flow",
        {
          ...this.pageDetails(page),
          currentGeneration: current.generation,
          observedGeneration: page.generation,
        },
      );
    }
    if (page.generation < current.generation) {
      return this.isolate(
        "STALE_PAGE",
        "event originated from a stale page generation",
        {
          ...this.pageDetails(page),
          currentGeneration: current.generation,
          observedGeneration: page.generation,
        },
      );
    }

    this.currentPage = page;

    switch (event.type) {
      case "navigation":
        return this.handleNavigation(event, page);
      case "auth_callback":
        return this.handleCallback(event, page);
      case "idp_choice":
        return this.handleIdpChoice(event, page);
      case "idp_selected":
        return this.handleIdpSelected(event, page);
      case "mfa_challenge":
        return this.handleMfaChallenge(event, page);
      case "mfa_completed":
        return this.handleMfaCompleted(event, page);
      case "page_activated":
        return this.handlePageActivated(event, page);
      default:
        return this.isolate(
          "INVALID_EVENT",
          `unsupported event type: ${String((event as { type?: unknown }).type)}`,
          this.pageDetails(page),
        );
    }
  }

  snapshot(): CoordinatorSnapshot {
    return Object.freeze({
      phase: this.currentPhase,
      page: this.currentPage,
      action: this.currentAction,
      evidence: Object.freeze([...this.ledger]),
    });
  }

  private handleNavigation(
    event: NavigationEvent,
    page: PageIdentity,
  ): CoordinatorSnapshot {
    const parsed = parseTopLevelUrl(event.url);
    if (parsed === null) {
      return this.isolate(
        "INVALID_URL",
        "navigation URL must be a secure absolute HTTP(S) URL without credentials",
        this.pageDetails(page),
      );
    }
    if (!this.policy.navigationOrigins.has(parsed.url.origin)) {
      return this.isolate(
        "UNEXPECTED_ORIGIN",
        "navigation crossed into an origin outside the SSO allowlist",
        { ...this.pageDetails(page), url: parsed.safe },
      );
    }

    const issuerResult = this.matchIssuer(event.issuer, parsed, false);
    if (!issuerResult.ok) {
      return this.isolate(issuerResult.code, issuerResult.message, {
        ...this.pageDetails(page),
        url: parsed.safe,
      });
    }

    const stateResult = this.matchState(event.state, parsed, "navigation");
    if (!stateResult.ok) {
      return this.isolate(stateResult.code, stateResult.message, {
        ...this.pageDetails(page),
        url: parsed.safe,
      });
    }

    const issuer = issuerResult.value.issuer;
    const state = stateResult.value;
    const callbackLike =
      this.policy.redirectOrigins.has(parsed.url.origin) &&
      issuer !== null &&
      state.present &&
      state.matched;

    if (callbackLike) {
      if (parsed.url.searchParams.has("error")) {
        return this.isolate(
          "AUTHENTICATION_ERROR",
          "authorization endpoint returned an error response",
          {
            ...this.pageDetails(page),
            url: parsed.safe,
            issuer,
            issuerAllowed: true,
            statePresent: true,
            stateMatched: true,
            redirectOrigin: parsed.url.origin,
          },
        );
      }
      if (this.currentPhase !== "navigating") {
        return this.isolate(
          "PAUSED_STEP_BYPASSED",
          "authentication callback arrived while a manual step was still pending",
          {
            ...this.pageDetails(page),
            url: parsed.safe,
            issuer,
            issuerAllowed: true,
            statePresent: true,
            stateMatched: true,
            redirectOrigin: parsed.url.origin,
          },
        );
      }
      return this.completeLogin(parsed, page, issuer);
    }

    this.append("NAVIGATION_ACCEPTED", "navigation accepted within the SSO allowlist", {
      ...this.pageDetails(page),
      url: parsed.safe,
      issuer: issuer ?? undefined,
      issuerAllowed: issuer === null ? undefined : true,
      statePresent: state.present,
      stateMatched: state.present ? state.matched : undefined,
    });
    return this.snapshot();
  }

  private handleCallback(
    event: AuthCallbackEvent,
    page: PageIdentity,
  ): CoordinatorSnapshot {
    const parsed = parseTopLevelUrl(event.url);
    if (parsed === null) {
      return this.isolate(
        "INVALID_URL",
        "callback URL must be a secure absolute HTTP(S) URL without credentials",
        this.pageDetails(page),
      );
    }
    if (!this.policy.navigationOrigins.has(parsed.url.origin)) {
      return this.isolate(
        "UNEXPECTED_ORIGIN",
        "callback crossed into an origin outside the SSO allowlist",
        { ...this.pageDetails(page), url: parsed.safe },
      );
    }
    if (!this.policy.redirectOrigins.has(parsed.url.origin)) {
      return this.isolate(
        "REDIRECT_ORIGIN_NOT_ALLOWED",
        "callback origin is not an allowed redirect origin",
        { ...this.pageDetails(page), url: parsed.safe },
      );
    }

    const issuerResult = this.matchIssuer(event.issuer, parsed, true);
    if (!issuerResult.ok) {
      return this.isolate(issuerResult.code, issuerResult.message, {
        ...this.pageDetails(page),
        url: parsed.safe,
      });
    }

    const stateResult = this.matchState(event.state, parsed, "callback");
    if (!stateResult.ok) {
      return this.isolate(stateResult.code, stateResult.message, {
        ...this.pageDetails(page),
        url: parsed.safe,
      });
    }

    const issuer = issuerResult.value.issuer;
    if (issuer === null) {
      return this.isolate("ISSUER_MISSING", "callback is missing its issuer", {
        ...this.pageDetails(page),
        url: parsed.safe,
      });
    }

    if (parsed.url.searchParams.has("error")) {
      return this.isolate(
        "AUTHENTICATION_ERROR",
        "authorization endpoint returned an error response",
        {
          ...this.pageDetails(page),
          url: parsed.safe,
          issuer,
          issuerAllowed: true,
          statePresent: true,
          stateMatched: true,
          redirectOrigin: parsed.url.origin,
        },
      );
    }

    if (this.currentPhase !== "navigating") {
      return this.isolate(
        "PAUSED_STEP_BYPASSED",
        "authentication callback arrived while a manual step was still pending",
        {
          ...this.pageDetails(page),
          url: parsed.safe,
          issuer,
          issuerAllowed: true,
          statePresent: true,
          stateMatched: true,
          redirectOrigin: parsed.url.origin,
        },
      );
    }

    return this.completeLogin(parsed, page, issuer);
  }

  private handleIdpChoice(
    event: IdpChoiceEvent,
    page: PageIdentity,
  ): CoordinatorSnapshot {
    if (this.currentPhase === "awaiting_mfa") {
      return this.isolate(
        "UNEXPECTED_PROTOCOL_EVENT",
        "IdP selection cannot replace a pending MFA challenge",
        this.pageDetails(page),
      );
    }
    if (
      this.currentPhase !== "navigating" &&
      this.currentPhase !== "awaiting_idp_selection"
    ) {
      return this.isolate(
        "UNEXPECTED_PROTOCOL_EVENT",
        "IdP selection is not valid in the current phase",
        this.pageDetails(page),
      );
    }

    const prepared = prepareCandidates(event.candidates, this.policy.allowedIssuers);
    if (prepared === null) {
      return this.isolate(
        "INVALID_EVENT",
        "IdP candidate list is malformed, empty, or contains duplicate ids",
        this.pageDetails(page),
      );
    }

    for (const rejectedId of prepared.rejectedIds) {
      this.append(
        "IDP_CANDIDATE_REJECTED",
        "IdP candidate was rejected because its issuer is not allowed",
        {
          ...this.pageDetails(page),
          idpId: rejectedId,
        },
      );
    }

    if (prepared.candidates.length === 0) {
      return this.isolate(
        "NO_ALLOWED_IDP",
        "IdP selection page offered no allowed issuer",
        {
          ...this.pageDetails(page),
          idpIds: prepared.rejectedIds,
        },
      );
    }

    this.idpCandidates = prepared.byId;
    this.selectedIdpId = null;
    this.currentPhase = "awaiting_idp_selection";
    this.setAction({
      type: "select_idp",
      candidates: prepared.candidates,
    });
    this.append("IDP_SELECTION_REQUIRED", "manual IdP selection is required", {
      ...this.pageDetails(page),
      idpIds: Object.freeze(prepared.candidates.map((candidate) => candidate.id)),
    });
    return this.snapshot();
  }

  private handleIdpSelected(
    event: IdpSelectedEvent,
    page: PageIdentity,
  ): CoordinatorSnapshot {
    const idpId = event.idpId;
    if (
      typeof idpId !== "string" ||
      idpId.length === 0 ||
      idpId.length > 128 ||
      CONTROL_CHARACTERS.test(idpId)
    ) {
      return this.isolate("INVALID_EVENT", "idpId must be a non-empty printable string", {
        ...this.pageDetails(page),
      });
    }

    const selected = this.idpCandidates.get(idpId);
    if (selected === undefined) {
      return this.isolate(
        "UNKNOWN_IDP",
        "selected IdP was not offered by the current selection prompt",
        {
          ...this.pageDetails(page),
          idpId,
        },
      );
    }

    if (this.currentPhase === "awaiting_idp_selection") {
      this.selectedIdpId = idpId;
      this.currentPhase = "navigating";
      this.setAction({ type: "wait_for_redirect" });
      this.append("IDP_SELECTED", "IdP selection accepted", {
        ...this.pageDetails(page),
        idpId,
        issuer: selected.issuer,
        issuerAllowed: true,
      });
      return this.snapshot();
    }

    if (this.currentPhase === "navigating" && this.selectedIdpId === idpId) {
      this.setAction({ type: "wait_for_redirect" });
      this.append("IDP_SELECTED", "duplicate IdP selection acknowledged", {
        ...this.pageDetails(page),
        idpId,
        issuer: selected.issuer,
        issuerAllowed: true,
      });
      return this.snapshot();
    }

    return this.isolate(
      "UNEXPECTED_PROTOCOL_EVENT",
      "IdP selection is not valid in the current phase",
      {
        ...this.pageDetails(page),
        idpId,
      },
    );
  }

  private handleMfaChallenge(
    event: MfaChallengeEvent,
    page: PageIdentity,
  ): CoordinatorSnapshot {
    if (
      this.currentPhase !== "navigating" &&
      this.currentPhase !== "awaiting_mfa"
    ) {
      return this.isolate(
        "UNEXPECTED_PROTOCOL_EVENT",
        "MFA challenge is not valid in the current phase",
        this.pageDetails(page),
      );
    }

    const methods = prepareMethods(event.methods);
    if (methods === null) {
      return this.isolate(
        "INVALID_EVENT",
        "MFA challenge must contain at least one valid method",
        this.pageDetails(page),
      );
    }

    this.currentPhase = "awaiting_mfa";
    this.setAction({ type: "await_mfa", methods });
    this.append("MFA_REQUIRED", "manual MFA completion is required", {
      ...this.pageDetails(page),
      methods,
    });
    return this.snapshot();
  }

  private handleMfaCompleted(
    _event: MfaCompletedEvent,
    page: PageIdentity,
  ): CoordinatorSnapshot {
    if (this.currentPhase === "awaiting_mfa") {
      this.currentPhase = "navigating";
      this.setAction({ type: "wait_for_redirect" });
      this.append("MFA_COMPLETED", "manual MFA step reported complete", {
        ...this.pageDetails(page),
      });
      return this.snapshot();
    }

    if (this.currentPhase === "navigating") {
      this.append("MFA_COMPLETED", "duplicate MFA completion acknowledged", {
        ...this.pageDetails(page),
      });
      return this.snapshot();
    }

    return this.isolate(
      "UNEXPECTED_PROTOCOL_EVENT",
      "MFA completion is not valid in the current phase",
      this.pageDetails(page),
    );
  }

  private handlePageActivated(
    event: PageActivatedEvent,
    page: PageIdentity,
  ): CoordinatorSnapshot {
    if (event.url !== undefined && typeof event.url !== "string") {
      return this.isolate("INVALID_EVENT", "activated page URL must be a string", {
        ...this.pageDetails(page),
      });
    }

    let parsed: ParsedUrl | null = null;
    if (event.url !== undefined) {
      parsed = parseTopLevelUrl(event.url);
      if (parsed === null) {
        return this.isolate(
          "INVALID_URL",
          "activated page URL must be a secure absolute HTTP(S) URL without credentials",
          this.pageDetails(page),
        );
      }
      if (!this.policy.navigationOrigins.has(parsed.url.origin)) {
        return this.isolate(
          "UNEXPECTED_ORIGIN",
          "activated page crossed into an origin outside the SSO allowlist",
          { ...this.pageDetails(page), url: parsed.safe },
        );
      }
    }

    this.append("PAGE_ACTIVATED", "page activation observed", {
      ...this.pageDetails(page),
      url: parsed === null ? undefined : parsed.safe,
    });
    return this.snapshot();
  }

  private completeLogin(
    parsed: ParsedUrl,
    page: PageIdentity,
    issuer: string,
  ): CoordinatorSnapshot {
    this.currentPhase = "completed";
    this.setAction({
      type: "login_complete",
      issuer,
      redirectOrigin: parsed.url.origin,
      page,
    });
    this.append("LOGIN_COMPLETED", "login completed after callback validation", {
      ...this.pageDetails(page),
      url: parsed.safe,
      issuer,
      issuerAllowed: true,
      statePresent: true,
      stateMatched: true,
      redirectOrigin: parsed.url.origin,
    });
    return this.snapshot();
  }

  private matchIssuer(
    explicit: unknown,
    parsed: ParsedUrl,
    required: boolean,
  ): CheckResult<IssuerMatch> {
    if (explicit !== undefined && typeof explicit !== "string") {
      return {
        ok: false,
        code: "INVALID_EVENT",
        message: "issuer must be a string when supplied",
      };
    }

    const urlIssuers = parsed.url.searchParams.getAll("iss");
    if (urlIssuers.length > 1) {
      return {
        ok: false,
        code: "ISSUER_AMBIGUOUS",
        message: "URL contains more than one issuer parameter",
      };
    }

    const urlIssuer = urlIssuers.length === 1 ? urlIssuers[0] ?? null : null;
    if (
      typeof explicit === "string" &&
      urlIssuer !== null &&
      explicit !== urlIssuer
    ) {
      return {
        ok: false,
        code: "ISSUER_CONFLICT",
        message: "explicit issuer conflicts with the issuer parameter in the URL",
      };
    }

    const issuer = typeof explicit === "string" ? explicit : urlIssuer;
    if (issuer === null) {
      if (required) {
        return {
          ok: false,
          code: "ISSUER_MISSING",
          message: "callback is missing its issuer",
        };
      }
      return { ok: true, value: { issuer: null, allowed: false } };
    }
    if (!this.policy.allowedIssuers.has(issuer)) {
      return {
        ok: false,
        code: "ISSUER_NOT_ALLOWED",
        message: "issuer is not present in the allowed issuer list",
      };
    }

    return { ok: true, value: { issuer, allowed: true } };
  }

  private matchState(
    explicit: unknown,
    parsed: ParsedUrl,
    mode: "navigation" | "callback",
  ): CheckResult<StateMatch> {
    if (explicit !== undefined && typeof explicit !== "string") {
      return {
        ok: false,
        code: "INVALID_EVENT",
        message: "state must be a string when supplied",
      };
    }

    const urlStates = parsed.url.searchParams.getAll("state");
    if (urlStates.length > 1) {
      return {
        ok: false,
        code: "STATE_AMBIGUOUS",
        message: "URL contains more than one state parameter",
      };
    }

    const compareUrlState =
      mode === "callback" ||
      explicit !== undefined ||
      this.policy.issuerOrigins.has(parsed.url.origin) ||
      this.policy.redirectOrigins.has(parsed.url.origin);
    const urlState =
      compareUrlState && urlStates.length === 1 ? urlStates[0] ?? null : null;

    if (
      typeof explicit === "string" &&
      urlState !== null &&
      explicit !== urlState
    ) {
      return {
        ok: false,
        code: "STATE_MISMATCH",
        message: "explicit state conflicts with the state parameter in the URL",
      };
    }

    const state = typeof explicit === "string" ? explicit : urlState;
    if (state === null) {
      if (mode === "callback") {
        return {
          ok: false,
          code: "STATE_MISSING",
          message: "callback is missing its state parameter",
        };
      }
      return { ok: true, value: { present: false, matched: false } };
    }

    if (!constantTimeEqual(state, this.policy.expectedState)) {
      return {
        ok: false,
        code: "STATE_MISMATCH",
        message: "state does not match the value bound at login start",
      };
    }

    return { ok: true, value: { present: true, matched: true } };
  }

  private isolate(
    code: IsolationCode,
    message: string,
    details: EvidenceDetails = {},
  ): CoordinatorSnapshot {
    const fromPhase = this.currentPhase;
    if (fromPhase === "isolated") {
      return this.snapshot();
    }

    this.currentPhase = "isolated";
    this.setAction({ type: "isolate", code, message });
    this.append("ISOLATED", message, { ...details, reason: code }, fromPhase);
    return this.snapshot();
  }

  private setAction(action: NextAction): void {
    this.currentAction = Object.freeze(action);
  }

  private append(
    code: EvidenceCode,
    message: string,
    details: EvidenceDetails,
    phase: Phase = this.currentPhase,
  ): void {
    this.sequence += 1;
    const record: EvidenceRecord = Object.freeze({
      seq: this.sequence,
      at: this.timestamp(),
      code,
      phase,
      message,
      ...details,
    });
    this.ledger.push(record);
  }

  private timestamp(): string {
    try {
      const value = this.policy.clock();
      if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString();
      }
    } catch {
      return new Date(0).toISOString();
    }
    return new Date(0).toISOString();
  }

  private pageDetails(page: PageIdentity): EvidenceDetails {
    return { tabId: page.tabId, generation: page.generation };
  }

  private eventContext(event: unknown): EvidenceDetails {
    if (!isRecord(event)) {
      return {};
    }

    const pageResult = validatePage(event.page);
    const parsed =
      typeof event.url === "string" ? parseTopLevelUrl(event.url) : null;
    return {
      ...(pageResult.ok ? this.pageDetails(pageResult.page) : {}),
      ...(parsed === null ? {} : { url: parsed.safe }),
    };
  }
}

export function createSsoLoginCoordinator(
  policy: SsoLoginPolicy,
): SsoLoginCoordinator {
  return new SsoLoginCoordinator(policy);
}
