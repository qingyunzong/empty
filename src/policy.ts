import { parseSource, matchSource, type MatchTarget } from "./source.js";
import type {
  PolicyVerdict,
  ResourcePolicy,
  ResourceType,
  SourceExpression,
} from "./types.js";
import {
  type OriginParts,
  effectivePort,
  normalizePath,
  parseOrigin,
  resolveTargetUrl,
} from "./url.js";

type DirectiveName = "default" | ResourceType;

const DIRECTIVES: DirectiveName[] = ["default", "script", "img"];

/**
 * Compile a policy once so repeated checks do not re-parse the same sources.
 * A directive containing `'none'` alongside other sources, or an unparseable
 * source, is marked invalid and then fails closed (denies everything).
 */
interface CompiledDirective {
  sources: ReturnType<typeof parseSource>[];
  invalid: boolean;
}

export interface CompiledPolicy {
  directives: Partial<Record<DirectiveName, CompiledDirective>>;
}

export function compilePolicy(policy: ResourcePolicy): CompiledPolicy {
  const compiled: CompiledPolicy = { directives: {} };
  for (const name of DIRECTIVES) {
    const bucket = policy[name];
    if (bucket === undefined) {
      continue;
    }
    compiled.directives[name] = compileDirective(bucket);
  }
  return compiled;
}

function compileDirective(bucket: SourceExpression[]): CompiledDirective {
  const lower = bucket.map((item) => item.trim().toLowerCase());
  const hasNone = lower.some((item) => item === "'none'" || item === "none");
  if (hasNone && bucket.length > 1) {
    return { sources: [], invalid: true };
  }
  try {
    return { sources: bucket.map(parseSource), invalid: false };
  } catch {
    return { sources: [], invalid: true };
  }
}

/**
 * Evaluate one compiled policy against a resource. Returns true when the
 * policy allows the load.
 */
export function policyAllows(
  compiled: CompiledPolicy,
  type: ResourceType,
  target: MatchTarget,
  page: OriginParts,
): boolean {
  const directive = compiled.directives[type] ?? compiled.directives.default;
  if (directive === undefined) {
    return true;
  }
  if (directive.invalid) {
    return false;
  }
  if (directive.sources.length === 0) {
    return false;
  }
  return directive.sources.some((source) => matchSource(source, target, page));
}

/**
 * Entry point used by callers. Pass the page origin, every policy object, the
 * resource URL (absolute, protocol-relative or relative) and its type.
 * Sources inside a policy are unioned; policies are intersected, so a single
 * denying policy rejects the whole load. The returned index arrays identify
 * which policies allowed or denied the resource.
 */
export function evaluateResource(
  pageOrigin: string,
  policies: ResourcePolicy[],
  resourceUrl: string,
  type: ResourceType,
): PolicyVerdict {
  const page = parseOrigin(pageOrigin);
  const url = resolveTargetUrl(resourceUrl, pageOrigin);
  const normalizedPath = normalizePath(url.pathname);
  const target: MatchTarget = {
    url,
    normalizedPath,
    origin: {
      scheme: url.protocol.toLowerCase(),
      host: url.hostname.toLowerCase(),
      port: effectivePort(url),
    },
  };
  if (normalizedPath === null) {
    const deniedBy = policies.map((_, index) => index);
    return { allowed: false, allowedBy: [], deniedBy };
  }

  const allowedBy: number[] = [];
  const deniedBy: number[] = [];
  policies.forEach((policy, index) => {
    const allows = policyAllows(compilePolicy(policy), type, target, page);
    if (allows) {
      allowedBy.push(index);
    } else {
      deniedBy.push(index);
    }
  });

  return { allowed: deniedBy.length === 0, allowedBy, deniedBy };
}
