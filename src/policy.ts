import type { SsoLoginPolicy } from "./types.js";
import { parseOrigin, parseTopLevelUrl } from "./url.js";

export interface NormalizedPolicy {
  readonly allowedIssuers: ReadonlyMap<string, string>;
  readonly issuerOrigins: ReadonlySet<string>;
  readonly redirectOrigins: ReadonlySet<string>;
  readonly applicationOrigins: ReadonlySet<string>;
  readonly navigationOrigins: ReadonlySet<string>;
  readonly expectedState: string;
  readonly clock: () => Date;
}

export class SsoPolicyError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid SSO login policy: ${issues.join("; ")}`);
    this.name = "SsoPolicyError";
    this.issues = Object.freeze([...issues]);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizePolicy(policy: SsoLoginPolicy): NormalizedPolicy {
  const issues: string[] = [];

  if (!isRecord(policy)) {
    throw new SsoPolicyError(["policy must be an object"]);
  }

  const allowedIssuers = new Map<string, string>();
  const issuerOrigins = new Set<string>();
  const rawIssuers = policy.allowedIssuers;
  if (!Array.isArray(rawIssuers) || rawIssuers.length === 0) {
    issues.push("allowedIssuers must contain at least one issuer");
  } else {
    for (const rawIssuer of rawIssuers) {
      if (typeof rawIssuer !== "string" || rawIssuer.trim() === "") {
        issues.push("allowedIssuers entries must be non-empty strings");
        continue;
      }
      const issuer = rawIssuer.trim();
      const parsed = parseTopLevelUrl(issuer);
      if (parsed === null || parsed.url.search !== "" || parsed.url.hash !== "") {
        issues.push(
          `allowedIssuers entry must be a secure absolute issuer without query or fragment: ${issuer}`,
        );
        continue;
      }
      if (allowedIssuers.has(issuer)) {
        issues.push(`duplicate allowed issuer: ${issuer}`);
        continue;
      }
      allowedIssuers.set(issuer, parsed.url.origin);
      issuerOrigins.add(parsed.url.origin);
    }
  }

  const redirectOrigins = new Set<string>();
  const rawRedirectOrigins = policy.allowedRedirectOrigins;
  if (!Array.isArray(rawRedirectOrigins) || rawRedirectOrigins.length === 0) {
    issues.push("allowedRedirectOrigins must contain at least one origin");
  } else {
    for (const rawOrigin of rawRedirectOrigins) {
      const origin = parseOrigin(rawOrigin);
      if (origin === null) {
        issues.push(`allowedRedirectOrigins entry must be an exact origin: ${String(rawOrigin)}`);
        continue;
      }
      redirectOrigins.add(origin);
    }
  }

  const applicationOrigins = new Set<string>();
  const rawApplicationOrigins = policy.applicationOrigins;
  if (!Array.isArray(rawApplicationOrigins) || rawApplicationOrigins.length === 0) {
    issues.push("applicationOrigins must contain at least one origin");
  } else {
    for (const rawOrigin of rawApplicationOrigins) {
      const origin = parseOrigin(rawOrigin);
      if (origin === null) {
        issues.push(`applicationOrigins entry must be an exact origin: ${String(rawOrigin)}`);
        continue;
      }
      applicationOrigins.add(origin);
    }
  }

  if (typeof policy.expectedState !== "string" || policy.expectedState.trim() === "") {
    issues.push("expectedState must be a non-empty string");
  }

  if (policy.now !== undefined && typeof policy.now !== "function") {
    issues.push("now must be a function returning a Date");
  }

  if (issues.length > 0) {
    throw new SsoPolicyError(issues);
  }

  const navigationOrigins = new Set<string>([
    ...applicationOrigins,
    ...redirectOrigins,
    ...issuerOrigins,
  ]);

  return {
    allowedIssuers,
    issuerOrigins,
    redirectOrigins,
    applicationOrigins,
    navigationOrigins,
    expectedState: policy.expectedState,
    clock: policy.now ?? (() => new Date()),
  };
}
