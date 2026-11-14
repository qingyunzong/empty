import test from "node:test";
import assert from "node:assert/strict";
import {
  SsoLoginCoordinator,
  SsoPolicyError,
  redactUrl,
  type AuthCallbackEvent,
  type PageIdentity,
  type SsoEvent,
  type SsoLoginPolicy,
} from "../index.js";

const APP_ORIGIN = "https://app.example.com";
const OTHER_ORIGIN = "https://other.example.com";
const WORK_ISSUER = "https://idp.example.com/tenant";
const PERSONAL_ISSUER = "https://idp2.example.com/tenant";
const EXPECTED_STATE = "expected-state-0123456789abcdef";
const FIXED_NOW = new Date("2026-11-14T00:00:00.000Z");

function page(generation: number, tabId = "tab-login"): PageIdentity {
  return { tabId, generation };
}

function policy(overrides: Partial<SsoLoginPolicy> = {}): SsoLoginPolicy {
  return {
    allowedIssuers: [WORK_ISSUER, PERSONAL_ISSUER],
    allowedRedirectOrigins: [APP_ORIGIN],
    applicationOrigins: [APP_ORIGIN],
    expectedState: EXPECTED_STATE,
    now: () => FIXED_NOW,
    ...overrides,
  };
}

function coordinator(overrides: Partial<SsoLoginPolicy> = {}): SsoLoginCoordinator {
  return new SsoLoginCoordinator(policy(overrides));
}

function callbackUrl(state = EXPECTED_STATE, extra = ""): string {
  return `${APP_ORIGIN}/callback?code=auth-code-value&state=${state}${extra}`;
}

function start(instance = coordinator()): SsoLoginCoordinator {
  instance.begin(page(0), `${APP_ORIGIN}/login`);
  return instance;
}

function authCallback(
  generation: number,
  state = EXPECTED_STATE,
  issuer = WORK_ISSUER,
): AuthCallbackEvent {
  return {
    type: "auth_callback",
    page: page(generation),
    url: callbackUrl(state),
    issuer,
    state,
  };
}

test("completes login only after allowed issuer, redirect origin, state and generation", () => {
  const instance = start();

  instance.dispatch({
    type: "navigation",
    page: page(1),
    url: `${WORK_ISSUER}/authorize?state=${EXPECTED_STATE}&client_id=rpa`,
  });

  const selection = instance.dispatch({
    type: "idp_choice",
    page: page(1),
    candidates: [
      { id: "work", displayName: "Work account", issuer: WORK_ISSUER },
      { id: "personal", displayName: "Personal account", issuer: PERSONAL_ISSUER },
    ],
  });
  assert.equal(selection.phase, "awaiting_idp_selection");
  assert.equal(selection.action.type, "select_idp");
  if (selection.action.type === "select_idp") {
    assert.deepEqual(
      selection.action.candidates.map((candidate) => candidate.id),
      ["work", "personal"],
    );
  }

  const selected = instance.dispatch({
    type: "idp_selected",
    page: page(1),
    idpId: "personal",
  });
  assert.equal(selected.phase, "navigating");
  assert.equal(selected.action.type, "wait_for_redirect");

  const mfa = instance.dispatch({
    type: "mfa_challenge",
    page: page(2),
    methods: ["push", "otp"],
  });
  assert.equal(mfa.phase, "awaiting_mfa");
  assert.deepEqual(
    mfa.action.type === "await_mfa" ? mfa.action.methods : [],
    ["push", "otp"],
  );

  const mfaDone = instance.dispatch({
    type: "mfa_completed",
    page: page(2),
  });
  assert.equal(mfaDone.phase, "navigating");

  const completed = instance.dispatch(
    authCallback(3, EXPECTED_STATE, PERSONAL_ISSUER),
  );
  assert.equal(completed.phase, "completed");
  assert.equal(completed.action.type, "login_complete");
  if (completed.action.type === "login_complete") {
    assert.equal(completed.action.issuer, PERSONAL_ISSUER);
    assert.equal(completed.action.redirectOrigin, APP_ORIGIN);
    assert.equal(completed.action.page.generation, 3);
  }

  const last = completed.evidence.at(-1);
  assert.equal(last?.code, "LOGIN_COMPLETED");
  assert.equal(last?.statePresent, true);
  assert.equal(last?.stateMatched, true);
  assert.equal(last?.issuerAllowed, true);
});

test("navigation to the redirect origin can complete the flow directly", () => {
  const instance = start();
  const completed = instance.dispatch({
    type: "navigation",
    page: page(1),
    url: callbackUrl(),
    issuer: WORK_ISSUER,
  });

  assert.equal(completed.phase, "completed");
  assert.equal(completed.action.type, "login_complete");
  assert.equal(completed.evidence.at(-1)?.code, "LOGIN_COMPLETED");
});

test("state mismatch isolates immediately and cannot be recovered", () => {
  const instance = start();
  const isolated = instance.dispatch(authCallback(1, "changed-state"));

  assert.equal(isolated.phase, "isolated");
  assert.equal(isolated.action.type, "isolate");
  if (isolated.action.type === "isolate") {
    assert.equal(isolated.action.code, "STATE_MISMATCH");
  }

  const replay = instance.dispatch(authCallback(1));
  assert.equal(replay.phase, "isolated");
  assert.equal(replay.action.type, "isolate");
  if (replay.action.type === "isolate") {
    assert.equal(replay.action.code, "STATE_MISMATCH");
  }
  assert.equal(replay.evidence.at(-1)?.code, "ISOLATED");
});

test("state changes across navigation are rejected", () => {
  const instance = start();
  instance.dispatch({
    type: "navigation",
    page: page(1),
    url: `${WORK_ISSUER}/authorize?state=${EXPECTED_STATE}`,
  });
  const isolated = instance.dispatch({
    type: "navigation",
    page: page(2),
    url: `${WORK_ISSUER}/authorize?state=replacement-state`,
  });

  assert.equal(isolated.phase, "isolated");
  assert.equal(isolated.action.type, "isolate");
  if (isolated.action.type === "isolate") {
    assert.equal(isolated.action.code, "STATE_MISMATCH");
  }
});

test("missing and ambiguous state fail closed", () => {
  const missing = start();
  const missingResult = missing.dispatch({
    type: "auth_callback",
    page: page(1),
    url: `${APP_ORIGIN}/callback?code=auth-code-value`,
    issuer: WORK_ISSUER,
  });
  assert.equal(missingResult.phase, "isolated");
  if (missingResult.action.type === "isolate") {
    assert.equal(missingResult.action.code, "STATE_MISSING");
  }

  const ambiguous = start();
  const ambiguousResult = ambiguous.dispatch({
    type: "auth_callback",
    page: page(1),
    url: `${APP_ORIGIN}/callback?state=${EXPECTED_STATE}&state=other`,
    issuer: WORK_ISSUER,
  });
  assert.equal(ambiguousResult.phase, "isolated");
  if (ambiguousResult.action.type === "isolate") {
    assert.equal(ambiguousResult.action.code, "STATE_AMBIGUOUS");
  }
});

test("explicit state conflicting with URL state is rejected", () => {
  const instance = start();
  const isolated = instance.dispatch({
    type: "auth_callback",
    page: page(1),
    url: callbackUrl("url-state"),
    issuer: WORK_ISSUER,
    state: EXPECTED_STATE,
  });

  assert.equal(isolated.phase, "isolated");
  if (isolated.action.type === "isolate") {
    assert.equal(isolated.action.code, "STATE_MISMATCH");
  }
});

test("unexpected cross-origin navigation isolates the flow", () => {
  const instance = start();
  const isolated = instance.dispatch({
    type: "navigation",
    page: page(1),
    url: "https://evil.example.net/login",
  });

  assert.equal(isolated.phase, "isolated");
  if (isolated.action.type === "isolate") {
    assert.equal(isolated.action.code, "UNEXPECTED_ORIGIN");
  }
});

test("callback must land on a configured redirect origin", () => {
  const instance = coordinator({
    applicationOrigins: [APP_ORIGIN, OTHER_ORIGIN],
    allowedRedirectOrigins: [APP_ORIGIN],
  });
  start(instance);

  const isolated = instance.dispatch({
    type: "auth_callback",
    page: page(1),
    url: `${OTHER_ORIGIN}/callback?state=${EXPECTED_STATE}`,
    issuer: WORK_ISSUER,
  });

  assert.equal(isolated.phase, "isolated");
  if (isolated.action.type === "isolate") {
    assert.equal(isolated.action.code, "REDIRECT_ORIGIN_NOT_ALLOWED");
  }
});

test("issuer not in the allowlist and issuer conflicts are rejected", () => {
  const disallowed = start();
  const result = disallowed.dispatch(
    authCallback(1, EXPECTED_STATE, "https://evil.example.net/tenant"),
  );
  assert.equal(result.phase, "isolated");
  if (result.action.type === "isolate") {
    assert.equal(result.action.code, "ISSUER_NOT_ALLOWED");
  }

  const conflict = start();
  const conflictResult = conflict.dispatch({
    type: "auth_callback",
    page: page(1),
    url: `${callbackUrl()}&iss=${encodeURIComponent(PERSONAL_ISSUER)}`,
    issuer: WORK_ISSUER,
  });
  assert.equal(conflictResult.phase, "isolated");
  if (conflictResult.action.type === "isolate") {
    assert.equal(conflictResult.action.code, "ISSUER_CONFLICT");
  }
});

test("missing issuer cannot complete login", () => {
  const instance = start();
  const event = {
    type: "auth_callback",
    page: page(1),
    url: callbackUrl(),
  } as unknown as SsoEvent;
  const isolated = instance.dispatch(event);

  assert.equal(isolated.phase, "isolated");
  if (isolated.action.type === "isolate") {
    assert.equal(isolated.action.code, "ISSUER_MISSING");
  }
});

test("stale generations and foreign tabs isolate immediately", () => {
  const stale = start();
  stale.dispatch({
    type: "navigation",
    page: page(2),
    url: `${WORK_ISSUER}/authorize?state=${EXPECTED_STATE}`,
  });
  const staleResult = stale.dispatch({
    type: "page_activated",
    page: page(1),
  });
  assert.equal(staleResult.phase, "isolated");
  if (staleResult.action.type === "isolate") {
    assert.equal(staleResult.action.code, "STALE_PAGE");
  }
  assert.equal(staleResult.evidence.at(-1)?.currentGeneration, 2);
  assert.equal(staleResult.evidence.at(-1)?.observedGeneration, 1);

  const foreign = start();
  const foreignResult = foreign.dispatch({
    type: "page_activated",
    page: page(1, "other-tab"),
  });
  assert.equal(foreignResult.phase, "isolated");
  if (foreignResult.action.type === "isolate") {
    assert.equal(foreignResult.action.code, "FOREIGN_TAB");
  }
});

test("returning to an old tab after completion isolates the flow", () => {
  const instance = start();
  const completed = instance.dispatch({
    type: "navigation",
    page: page(1),
    url: callbackUrl(),
    issuer: WORK_ISSUER,
  });
  assert.equal(completed.phase, "completed");

  const late = instance.dispatch({
    type: "page_activated",
    page: page(0),
  });
  assert.equal(late.phase, "isolated");
  if (late.action.type === "isolate") {
    assert.equal(late.action.code, "POST_COMPLETION_ACTIVITY");
  }
});

test("IdP selection pauses and validates the selected id", () => {
  const instance = start();
  instance.dispatch({
    type: "idp_choice",
    page: page(1),
    candidates: [
      { id: "work", issuer: WORK_ISSUER },
      { id: "personal", issuer: PERSONAL_ISSUER },
    ],
  });

  const bypass = instance.dispatch(authCallback(1));
  assert.equal(bypass.phase, "isolated");
  if (bypass.action.type === "isolate") {
    assert.equal(bypass.action.code, "PAUSED_STEP_BYPASSED");
  }

  const unknown = start();
  unknown.dispatch({
    type: "idp_choice",
    page: page(1),
    candidates: [{ id: "work", issuer: WORK_ISSUER }],
  });
  const unknownResult = unknown.dispatch({
    type: "idp_selected",
    page: page(1),
    idpId: "not-offered",
  });
  assert.equal(unknownResult.phase, "isolated");
  if (unknownResult.action.type === "isolate") {
    assert.equal(unknownResult.action.code, "UNKNOWN_IDP");
  }
});

test("untrusted IdP candidates are filtered and never selectable", () => {
  const instance = start();
  const selection = instance.dispatch({
    type: "idp_choice",
    page: page(1),
    candidates: [
      { id: "work", issuer: WORK_ISSUER },
      { id: "evil", issuer: "https://evil.example.net/tenant" },
    ],
  });

  assert.equal(selection.phase, "awaiting_idp_selection");
  assert.equal(selection.action.type, "select_idp");
  if (selection.action.type === "select_idp") {
    assert.deepEqual(
      selection.action.candidates.map((candidate) => candidate.id),
      ["work"],
    );
  }
  assert.ok(
    selection.evidence.some((record) => record.code === "IDP_CANDIDATE_REJECTED"),
  );

  const onlyEvil = start();
  const isolated = onlyEvil.dispatch({
    type: "idp_choice",
    page: page(1),
    candidates: [
      { id: "evil", issuer: "https://evil.example.net/tenant" },
    ],
  });
  assert.equal(isolated.phase, "isolated");
  if (isolated.action.type === "isolate") {
    assert.equal(isolated.action.code, "NO_ALLOWED_IDP");
  }
});

test("MFA pauses, rejects callback bypass, then resumes", () => {
  const instance = start();
  const challenge = instance.dispatch({
    type: "mfa_challenge",
    page: page(1),
    methods: ["webauthn"],
  });
  assert.equal(challenge.phase, "awaiting_mfa");

  const bypass = instance.dispatch(authCallback(2));
  assert.equal(bypass.phase, "isolated");
  if (bypass.action.type === "isolate") {
    assert.equal(bypass.action.code, "PAUSED_STEP_BYPASSED");
  }

  const resumed = start();
  resumed.dispatch({
    type: "mfa_challenge",
    page: page(1),
    methods: ["push"],
  });
  const completedMfa = resumed.dispatch({
    type: "mfa_completed",
    page: page(1),
  });
  assert.equal(completedMfa.phase, "navigating");
  const login = resumed.dispatch(authCallback(2));
  assert.equal(login.phase, "completed");
});

test("authorization errors do not count as login completion", () => {
  const instance = start();
  const isolated = instance.dispatch({
    type: "auth_callback",
    page: page(1),
    url: `${APP_ORIGIN}/callback?error=access_denied&state=${EXPECTED_STATE}`,
    issuer: WORK_ISSUER,
  });

  assert.equal(isolated.phase, "isolated");
  if (isolated.action.type === "isolate") {
    assert.equal(isolated.action.code, "AUTHENTICATION_ERROR");
  }
});

test("credentials in URLs are rejected", () => {
  const instance = start();
  const isolated = instance.dispatch({
    type: "navigation",
    page: page(1),
    url: "https://user:pass@idp.example.com/tenant/authorize",
  });

  assert.equal(isolated.phase, "isolated");
  if (isolated.action.type === "isolate") {
    assert.equal(isolated.action.code, "INVALID_URL");
  }
});

test("throwing event accessors fail closed as invalid events", () => {
  const instance = start();
  const event = {
    get type(): string {
      throw new Error("unexpected getter");
    },
  } as unknown as SsoEvent;
  const isolated = instance.dispatch(event);

  assert.equal(isolated.phase, "isolated");
  if (isolated.action.type === "isolate") {
    assert.equal(isolated.action.code, "INVALID_EVENT");
  }
});

test("entry URL must belong to an application origin", () => {
  const instance = coordinator();
  const isolated = instance.begin(page(0), "https://evil.example.net/login");

  assert.equal(isolated.phase, "isolated");
  if (isolated.action.type === "isolate") {
    assert.equal(isolated.action.code, "UNEXPECTED_ORIGIN");
  }
});

test("begin validates page identity and may only run once", () => {
  const instance = coordinator();
  const invalid = instance.begin(page(-1), `${APP_ORIGIN}/login`);
  assert.equal(invalid.phase, "isolated");
  if (invalid.action.type === "isolate") {
    assert.equal(invalid.action.code, "INVALID_PAGE");
  }

  const twice = start();
  const second = twice.begin(page(0), `${APP_ORIGIN}/login`);
  assert.equal(second.phase, "isolated");
  if (second.action.type === "isolate") {
    assert.equal(second.action.code, "ALREADY_STARTED");
  }
});

test("policy validation rejects ambiguous or insecure configuration", () => {
  assert.throws(
    () =>
      new SsoLoginCoordinator(
        policy({
          allowedIssuers: ["http://idp.example.com/tenant"],
          expectedState: "",
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof SsoPolicyError);
      assert.equal(error.issues.length, 2);
      return true;
    },
  );

  assert.throws(
    () =>
      new SsoLoginCoordinator(
        policy({
          allowedRedirectOrigins: [`${APP_ORIGIN}/callback`],
        }),
      ),
    SsoPolicyError,
  );
});

test("loopback HTTP origins are accepted for local integration", () => {
  const instance = new SsoLoginCoordinator({
    allowedIssuers: ["http://localhost:8080/tenant"],
    allowedRedirectOrigins: ["http://localhost:3000"],
    applicationOrigins: ["http://localhost:3000"],
    expectedState: EXPECTED_STATE,
    now: () => FIXED_NOW,
  });
  const started = instance.begin(page(0), "http://localhost:3000/login");
  assert.equal(started.phase, "navigating");
});

test("evidence is immutable and never contains secrets or raw query values", () => {
  const instance = start();
  const event = {
    type: "auth_callback",
    page: page(1),
    url: `${callbackUrl()}&access_token=top-secret-token#id-token=secret-fragment`,
    issuer: WORK_ISSUER,
    state: EXPECTED_STATE,
    password: "hunter2",
    otp: "123456",
  } as unknown as SsoEvent;
  const completed = instance.dispatch(event);

  assert.equal(completed.phase, "completed");
  const serialized = JSON.stringify(completed.evidence);
  assert.equal(serialized.includes("auth-code-value"), false);
  assert.equal(serialized.includes("top-secret-token"), false);
  assert.equal(serialized.includes("secret-fragment"), false);
  assert.equal(serialized.includes("hunter2"), false);
  assert.equal(serialized.includes("123456"), false);
  assert.equal(serialized.includes(EXPECTED_STATE), false);

  const callbackEvidence = completed.evidence.at(-1);
  assert.equal(callbackEvidence?.url?.origin, APP_ORIGIN);
  assert.equal(callbackEvidence?.url?.pathname, "/callback");
  assert.deepEqual(
    callbackEvidence?.url?.queryKeys,
    ["access_token", "code", "state"],
  );
  assert.equal(callbackEvidence?.url?.hasFragment, true);

  assert.equal(Object.isFrozen(completed), true);
  assert.equal(Object.isFrozen(completed.evidence), true);
  assert.equal(Object.isFrozen(callbackEvidence), true);
  assert.equal(Object.isFrozen(completed.page), true);
});

test("redactUrl exposes only origin, path and query key names", () => {
  const redacted = redactUrl(
    "https://app.example.com/callback?code=secret&state=hidden#token=secret",
  );

  assert.deepEqual(redacted, {
    origin: APP_ORIGIN,
    pathname: "/callback",
    queryKeys: ["code", "state"],
    hasFragment: true,
  });
  assert.equal(redactUrl("https://user:pass@app.example.com/x"), null);
  assert.equal(redactUrl("javascript:alert(1)"), null);
});
