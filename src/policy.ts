import { DomainEntry, Policy, UrlParts, defaultPort } from "./types.js";

// Proper-subdomain relation: returns the subdomain prefix of `host`
// relative to `base`, or null when host is the root or outside the base.
// "a.b.example.com" vs "example.com" -> "a.b"
// "example.com"     vs "example.com" -> null  (wildcard excludes the root)
export function subdomainOf(host: string, base: string): string | null {
  if (host === base) return null;
  if (host.endsWith("." + base)) return host.slice(0, host.length - base.length - 1);
  return null;
}

export function subdomainAllowed(entry: DomainEntry, sub: string): boolean {
  if (entry.allow !== null && !entry.allow.includes(sub)) return false;
  if (entry.exclude.includes(sub)) return false;
  return true;
}

export function entryMatchesHost(entry: DomainEntry, host: string): boolean {
  if (entry.kind === "exact") {
    return host === entry.domain && subdomainAllowed(entry, "");
  }
  const sub = subdomainOf(host, entry.domain);
  return sub !== null && subdomainAllowed(entry, sub);
}

export function matchUrl(policy: Policy, url: UrlParts): boolean {
  if (!policy.protocols.includes(url.protocol)) return false;
  if (policy.ports !== null) {
    const port = url.port ?? defaultPort(url.protocol);
    if (port === null || !policy.ports.includes(port)) return false;
  }
  return policy.entries.some((e) => entryMatchesHost(e, url.host));
}

// A wildcard entry is viable iff some non-empty subdomain can pass its
// allow/exclude sets. With allow === null the subdomain space is infinite
// and a finite exclude set can never cover it.
export function wildcardViable(entry: DomainEntry): boolean {
  if (entry.allow === null) return true;
  return entry.allow.some((s) => s !== "" && !entry.exclude.includes(s));
}

export function exactViable(entry: DomainEntry): boolean {
  return subdomainAllowed(entry, "");
}
