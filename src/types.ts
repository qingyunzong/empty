export interface PageIdentity {
  readonly tabId: string;
  readonly generation: number;
}

export interface IdpCandidate {
  readonly id: string;
  readonly displayName?: string;
  readonly issuer: string;
}

export interface SsoLoginPolicy {
  readonly allowedIssuers: readonly string[];
  readonly allowedRedirectOrigins: readonly string[];
  readonly applicationOrigins: readonly string[];
  readonly expectedState: string;
  readonly now?: () => Date;
}

export interface NavigationEvent {
  readonly type: "navigation";
  readonly page: PageIdentity;
  readonly url: string;
  readonly issuer?: string;
  readonly state?: string;
}

export interface AuthCallbackEvent {
  readonly type: "auth_callback";
  readonly page: PageIdentity;
  readonly url: string;
  readonly issuer: string;
  readonly state?: string;
}

export interface IdpChoiceEvent {
  readonly type: "idp_choice";
  readonly page: PageIdentity;
  readonly candidates: readonly IdpCandidate[];
}

export interface IdpSelectedEvent {
  readonly type: "idp_selected";
  readonly page: PageIdentity;
  readonly idpId: string;
}

export interface MfaChallengeEvent {
  readonly type: "mfa_challenge";
  readonly page: PageIdentity;
  readonly methods: readonly string[];
}

export interface MfaCompletedEvent {
  readonly type: "mfa_completed";
  readonly page: PageIdentity;
}

export interface PageActivatedEvent {
  readonly type: "page_activated";
  readonly page: PageIdentity;
  readonly url?: string;
}

export type SsoEvent =
  | NavigationEvent
  | AuthCallbackEvent
  | IdpChoiceEvent
  | IdpSelectedEvent
  | MfaChallengeEvent
  | MfaCompletedEvent
  | PageActivatedEvent;

export type Phase =
  | "idle"
  | "navigating"
  | "awaiting_idp_selection"
  | "awaiting_mfa"
  | "completed"
  | "isolated";

export type IsolationCode =
  | "ALREADY_STARTED"
  | "AUTHENTICATION_ERROR"
  | "FOREIGN_TAB"
  | "INVALID_EVENT"
  | "INVALID_PAGE"
  | "INVALID_URL"
  | "ISSUER_AMBIGUOUS"
  | "ISSUER_CONFLICT"
  | "ISSUER_MISSING"
  | "ISSUER_NOT_ALLOWED"
  | "NO_ALLOWED_IDP"
  | "PAUSED_STEP_BYPASSED"
  | "POST_COMPLETION_ACTIVITY"
  | "REDIRECT_ORIGIN_NOT_ALLOWED"
  | "STALE_PAGE"
  | "STATE_AMBIGUOUS"
  | "STATE_MISMATCH"
  | "STATE_MISSING"
  | "UNEXPECTED_ORIGIN"
  | "UNEXPECTED_PROTOCOL_EVENT"
  | "UNKNOWN_IDP";

export type EvidenceCode =
  | "FLOW_STARTED"
  | "NAVIGATION_ACCEPTED"
  | "PAGE_ACTIVATED"
  | "IDP_SELECTION_REQUIRED"
  | "IDP_CANDIDATE_REJECTED"
  | "IDP_SELECTED"
  | "MFA_REQUIRED"
  | "MFA_COMPLETED"
  | "LOGIN_COMPLETED"
  | "ISOLATED";

export interface SafeUrl {
  readonly origin: string;
  readonly pathname: string;
  readonly queryKeys: readonly string[];
  readonly hasFragment: boolean;
}

export interface EvidenceRecord {
  readonly seq: number;
  readonly at: string;
  readonly code: EvidenceCode;
  readonly phase: Phase;
  readonly message: string;
  readonly tabId?: string;
  readonly generation?: number;
  readonly url?: SafeUrl;
  readonly issuer?: string;
  readonly issuerAllowed?: boolean;
  readonly statePresent?: boolean;
  readonly stateMatched?: boolean;
  readonly idpId?: string;
  readonly idpIds?: readonly string[];
  readonly methods?: readonly string[];
  readonly redirectOrigin?: string;
  readonly currentGeneration?: number;
  readonly observedGeneration?: number;
  readonly reason?: IsolationCode;
}

export type NextAction =
  | { readonly type: "begin" }
  | { readonly type: "wait_for_redirect" }
  | {
      readonly type: "select_idp";
      readonly candidates: readonly IdpCandidate[];
    }
  | { readonly type: "await_mfa"; readonly methods: readonly string[] }
  | {
      readonly type: "login_complete";
      readonly issuer: string;
      readonly redirectOrigin: string;
      readonly page: PageIdentity;
    }
  | {
      readonly type: "isolate";
      readonly code: IsolationCode;
      readonly message: string;
    };

export interface CoordinatorSnapshot {
  readonly phase: Phase;
  readonly page: PageIdentity | null;
  readonly action: NextAction;
  readonly evidence: readonly EvidenceRecord[];
}
