import {
  DomainEntry,
  Policy,
  canonicalEntries,
  defaultPort,
  parseUrl,
} from "./types.js";
import {
  exactViable,
  matchUrl,
  subdomainAllowed,
  subdomainOf,
  wildcardViable,
} from "./policy.js";

export interface IntersectionResult {
  policy: Policy;
  emptyReasons: string[];
}

function intersectStrings(a: string[], b: string[]): string[] {
  return a.filter((x) => b.includes(x));
}

function unionStrings(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

// null = unrestricted; combining restrictions from both sides.
function combineAllow(
  x: string[] | null,
  y: string[] | null
): string[] | null {
  if (x === null) return y;
  if (y === null) return x;
  return intersectStrings(x, y);
}

// A shallower wildcard base b0 with deeper result base w = "<q>.<b0>" sees
// hosts whose subdomain relative to b0 is "<s>.<q>". Translate its
// allow/exclude sets (over "<s>.<q>") into sets over s.
// s === "" never occurs (wildcards exclude their root), so members equal
// to q itself are dropped.
function shiftSet(set: string[], q: string): string[] {
  const suffix = "." + q;
  const out: string[] = [];
  for (const member of set) {
    if (member.endsWith(suffix)) out.push(member.slice(0, member.length - suffix.length));
  }
  return out;
}

function intersectEntryPairs(a: DomainEntry, b: DomainEntry): DomainEntry[] {
  if (a.kind === "exact" && b.kind === "exact") {
    if (a.domain !== b.domain) return [];
    const entry: DomainEntry = {
      kind: "exact",
      domain: a.domain,
      allow: combineAllow(a.allow, b.allow),
      exclude: unionStrings(a.exclude, b.exclude),
    };
    return exactViable(entry) ? [entry] : [];
  }

  if (a.kind === "exact" && b.kind === "wildcard") {
    const sub = subdomainOf(a.domain, b.domain);
    if (sub === null) return [];
    // The single host is fully decided by both source entries, so the
    // resulting exact entry carries no residual restriction.
    if (subdomainAllowed(a, "") && subdomainAllowed(b, sub)) {
      return [{ kind: "exact", domain: a.domain, allow: null, exclude: [] }];
    }
    return [];
  }
  if (a.kind === "wildcard" && b.kind === "exact") {
    return intersectEntryPairs(b, a);
  }

  // wildcard x wildcard
  const wa = a.domain;
  const wb = b.domain;
  if (wa === wb) {
    const entry: DomainEntry = {
      kind: "wildcard",
      domain: wa,
      allow: combineAllow(a.allow, b.allow),
      exclude: unionStrings(a.exclude, b.exclude),
    };
    return wildcardViable(entry) ? [entry] : [];
  }
  const qa = subdomainOf(wa, wb); // wa = "<qa>.<wb>" -> wa is the deeper base
  const qb = subdomainOf(wb, wa); // wb = "<qb>.<wa>" -> wb is the deeper base
  if (qa !== null) {
    const entry: DomainEntry = {
      kind: "wildcard",
      domain: wa,
      allow: combineAllow(a.allow, b.allow === null ? null : shiftSet(b.allow, qa)),
      exclude: unionStrings(a.exclude, shiftSet(b.exclude, qa)),
    };
    return wildcardViable(entry) ? [entry] : [];
  }
  if (qb !== null) {
    const entry: DomainEntry = {
      kind: "wildcard",
      domain: wb,
      allow: combineAllow(b.allow, a.allow === null ? null : shiftSet(a.allow, qb)),
      exclude: unionStrings(b.exclude, shiftSet(a.exclude, qb)),
    };
    return wildcardViable(entry) ? [entry] : [];
  }
  return [];
}

export function intersectPolicies(a: Policy, b: Policy): IntersectionResult {
  const emptyReasons: string[] = [];

  const protocols = intersectStrings(a.protocols, b.protocols);
  if (protocols.length === 0) emptyReasons.push("protocols are disjoint");

  let ports: number[] | null;
  if (a.ports === null) ports = b.ports;
  else if (b.ports === null) ports = a.ports;
  else ports = a.ports.filter((p) => b.ports!.includes(p));
  if (ports !== null && ports.length === 0) emptyReasons.push("ports are disjoint");

  const entries: DomainEntry[] = [];
  for (const ea of a.entries) {
    for (const eb of b.entries) {
      entries.push(...intersectEntryPairs(ea, eb));
    }
  }
  const canonical = canonicalEntries(entries);
  if (canonical.length === 0) emptyReasons.push("no viable domain rule survives the intersection");

  const redirectBudget =
    a.redirectBudget === null
      ? b.redirectBudget
      : b.redirectBudget === null
        ? a.redirectBudget
        : Math.min(a.redirectBudget, b.redirectBudget);

  return {
    policy: {
      name: `intersection(${a.name},${b.name})`,
      protocols,
      ports,
      entries: canonical,
      redirectBudget,
    },
    emptyReasons,
  };
}

export function isEmpty(result: IntersectionResult): boolean {
  return result.emptyReasons.length > 0;
}

// Deterministic witness URL for a non-empty intersection.
export function witnessUrl(result: IntersectionResult, a: Policy, b: Policy): string {
  const p = result.policy;
  const entry = p.entries[0];
  if (!entry) throw new Error("cannot build a witness for an empty intersection");

  let host: string;
  if (entry.kind === "exact") {
    host = entry.domain;
  } else {
    let sub: string | null = null;
    if (entry.allow !== null) {
      sub = entry.allow.find((s) => s !== "" && !entry.exclude.includes(s)) ?? null;
    } else {
      for (let i = 0; ; i++) {
        const candidate = i === 0 ? "w" : `w${i}`;
        if (!entry.exclude.includes(candidate)) {
          sub = candidate;
          break;
        }
      }
    }
    if (sub === null) throw new Error("wildcard entry has no usable subdomain");
    host = `${sub}.${entry.domain}`;
  }

  const protocol = p.protocols[0]!;
  const port = p.ports === null ? null : p.ports[0]!;
  const explicitPort = port !== null && port !== defaultPort(protocol);
  const url = `${protocol}://${host}${explicitPort ? `:${port}` : ""}/`;

  // The witness must satisfy the intersection and both sources.
  const parts = parseUrl(url);
  if (!matchUrl(p, parts) || !matchUrl(a, parts) || !matchUrl(b, parts)) {
    throw new Error(`internal error: witness ${url} rejected`);
  }
  return url;
}

export function policyToJSON(p: Policy): unknown {
  return {
    name: p.name,
    protocols: p.protocols,
    ports: p.ports,
    domains: p.entries.map((e) => ({
      kind: e.kind,
      domain: e.domain,
      allow: e.allow,
      exclude: e.exclude,
    })),
    redirectBudget: p.redirectBudget,
  };
}
