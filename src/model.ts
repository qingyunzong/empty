// Rule model, validation, canonicalization and URL matching semantics.

export type Protocol = "http" | "https";

export interface Rule {
  name: string;
  protocols: Protocol[];
  ports: number[];
  // Exact hosts allowed (matched literally).
  exactDomains: string[];
  // Wildcard roots: `root` matches any *strict* subdomain of root (`*.root`),
  // but never the root domain itself.
  wildcardDomains: string[];
  // Additional explicitly allowed hosts (subdomain allow-set).
  allowSubdomains: string[];
  // Explicitly denied hosts; exclusion always wins over any allow.
  excludeSubdomains: string[];
  // Redirect budget: maximum number of redirects allowed in a chain.
  // null means the budget is unclosed (unbounded).
  maxRedirects: number | null;
}

export interface UrlParts {
  protocol: Protocol;
  host: string;
  port: number;
}

export class RuleError extends Error {}

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeHost(raw: unknown, field: string): string {
  if (typeof raw !== "string") {
    throw new RuleError(`${field}: host must be a string, got ${typeof raw}`);
  }
  let host = raw.trim().toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) {
    throw new RuleError(`${field}: invalid host ${JSON.stringify(raw)}`);
  }
  for (const label of host.split(".")) {
    if (!HOST_LABEL.test(label)) {
      throw new RuleError(`${field}: invalid host ${JSON.stringify(raw)}`);
    }
  }
  return host;
}

function parseHostList(raw: unknown, field: string, stripWildcardPrefix: boolean): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new RuleError(`${field}: must be an array of hosts`);
  return raw.map((entry) => {
    let value = entry;
    if (stripWildcardPrefix && typeof value === "string" && value.startsWith("*.")) {
      value = value.slice(2);
    }
    return normalizeHost(value, field);
  });
}

function parseProtocols(raw: unknown, source: string): Protocol[] {
  if (raw === undefined) return ["http", "https"];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new RuleError(`${source}: protocols must be a non-empty array`);
  }
  const out: Protocol[] = [];
  for (const p of raw) {
    if (p !== "http" && p !== "https") {
      throw new RuleError(`${source}: unsupported protocol ${JSON.stringify(p)}`);
    }
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

function parsePorts(raw: unknown, source: string): number[] {
  if (raw === undefined) return [80, 443];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new RuleError(`${source}: ports must be a non-empty array`);
  }
  const out: number[] = [];
  for (const p of raw) {
    if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535) {
      throw new RuleError(`${source}: invalid port ${JSON.stringify(p)}`);
    }
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

function parseBudget(raw: unknown, source: string): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new RuleError(`${source}: maxRedirects must be a non-negative integer or null`);
  }
  return raw;
}

export function parseRule(raw: unknown, source: string): Rule {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RuleError(`${source}: rule must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  return {
    name: typeof obj.name === "string" ? obj.name : source,
    protocols: parseProtocols(obj.protocols, source),
    ports: parsePorts(obj.ports, source),
    exactDomains: parseHostList(obj.exactDomains, "exactDomains", false),
    wildcardDomains: parseHostList(obj.wildcardDomains, "wildcardDomains", true),
    allowSubdomains: parseHostList(obj.allowSubdomains, "allowSubdomains", false),
    excludeSubdomains: parseHostList(obj.excludeSubdomains, "excludeSubdomains", false),
    maxRedirects: parseBudget(obj.maxRedirects, source),
  };
}

// host is a strict subdomain of root: `a.root` yes, `root` no, `otherroot` no.
export function isStrictSubdomain(host: string, root: string): boolean {
  return host.length > root.length && host.endsWith("." + root);
}

export function hostMatches(rule: Rule, host: string): boolean {
  if (rule.excludeSubdomains.includes(host)) return false;
  if (rule.exactDomains.includes(host)) return true;
  if (rule.allowSubdomains.includes(host)) return true;
  return rule.wildcardDomains.some((root) => isStrictSubdomain(host, root));
}

export function defaultPort(protocol: Protocol): number {
  return protocol === "https" ? 443 : 80;
}

export function matchUrl(rule: Rule, url: UrlParts): boolean {
  return (
    rule.protocols.includes(url.protocol) &&
    rule.ports.includes(url.port) &&
    hostMatches(rule, url.host)
  );
}

export function parseUrl(raw: string): UrlParts {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RuleError(`invalid URL: ${raw}`);
  }
  const protocol = parsed.protocol.replace(":", "");
  if (protocol !== "http" && protocol !== "https") {
    throw new RuleError(`unsupported protocol in URL: ${raw}`);
  }
  const host = normalizeHost(parsed.hostname, "url");
  const port = parsed.port === "" ? defaultPort(protocol) : Number(parsed.port);
  return { protocol, host, port };
}

export function formatUrl(url: UrlParts): string {
  return `${url.protocol}://${url.host}:${url.port}/`;
}

function uniqSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

// Canonical form: sorted/deduped lists, redundant wildcard roots removed
// (a root that is itself a strict subdomain of another root adds nothing),
// exact hosts folded into allowSubdomains, excluded exact hosts dropped,
// exclusions kept only where they actually cut into wildcard coverage.
// Two rules accept the same URL set iff their canonical forms agree on
// protocols, ports, exactDomains, wildcardDomains and excludeSubdomains.
export function canonicalize(rule: Rule): Rule {
  const wildcards = uniqSorted(rule.wildcardDomains).filter(
    (root, _i, all) => !all.some((other) => other !== root && isStrictSubdomain(root, other))
  );
  const excluded = new Set(rule.excludeSubdomains);
  const exacts = uniqSorted([...rule.exactDomains, ...rule.allowSubdomains]).filter(
    (host) => !excluded.has(host) && !wildcards.some((root) => isStrictSubdomain(host, root))
  );
  const excludes = uniqSorted(rule.excludeSubdomains).filter((host) =>
    wildcards.some((root) => isStrictSubdomain(host, root))
  );
  return {
    name: rule.name,
    protocols: uniqSorted(rule.protocols) as Protocol[],
    ports: [...new Set(rule.ports)].sort((x, y) => x - y),
    exactDomains: exacts,
    wildcardDomains: wildcards,
    allowSubdomains: [],
    excludeSubdomains: excludes,
    maxRedirects: rule.maxRedirects,
  };
}

export function hostSetIsEmpty(rule: Rule): boolean {
  return rule.exactDomains.length === 0 && rule.wildcardDomains.length === 0;
}

// A fresh strict subdomain of root that is not in the excludedset, used to build
// witnesses and distinguishing URLs. Exclusion sets are finite, so the loop
// always terminates.
export function freshSubdomain(root: string, excluded: Set<string>): string {
  const labels = ["w", "x", "y", "z", "www", "a", "b", "c"];
  for (const label of labels) {
    const host = `${label}.${root}`;
    if (!excluded.has(host)) return host;
  }
  for (let i = 0; ; i++) {
    const host = `w${i}.${root}`;
    if (!excluded.has(host)) return host;
  }
}
