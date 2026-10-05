// Finite small-domain enumeration used to cross-check the symbolic matching
// semantics: every claim produced by the symbolic algorithms is verified
// pointwise over a bounded universe of URLs (and chains of URLs) built from
// the domains, protocols and ports mentioned by the input rules.

import { Protocol, Rule, UrlParts, formatUrl, matchUrl } from "./model";

export interface UrlUniverse {
  urls: UrlParts[];
  hosts: string[];
  protocols: Protocol[];
  ports: number[];
}

export interface UniverseOptions {
  maxHosts: number;
  maxPorts: number;
  // URLs that must be present in the universe even if the caps would
  // otherwise cut them (e.g. a distinguishing chain under inspection).
  extraUrls?: UrlParts[];
}

export function buildUniverse(rules: Rule[], options: UniverseOptions): UrlUniverse {
  const hosts = new Set<string>();
  const ports = new Set<number>();
  const protocols = new Set<Protocol>();
  for (const rule of rules) {
    for (const host of rule.exactDomains) hosts.add(host);
    for (const host of rule.allowSubdomains) hosts.add(host);
    for (const host of rule.excludeSubdomains) hosts.add(host);
    for (const root of rule.wildcardDomains) {
      hosts.add(root); // the root itself: wildcards must NOT match it
      hosts.add(`w.${root}`);
      hosts.add(`x.${root}`);
      hosts.add(`w.x.${root}`);
    }
    for (const port of rule.ports) ports.add(port);
    for (const protocol of rule.protocols) protocols.add(protocol);
  }
  // Hosts that no rule mentions, to confirm both sides reject them.
  hosts.add("unrelated.example");
  hosts.add("w.unrelated.example");

  const hostList = [...hosts].sort().slice(0, options.maxHosts);
  const portList = [...ports].sort((x, y) => x - y).slice(0, options.maxPorts);
  const protocolList = [...protocols].sort();

  const seen = new Set<string>();
  const urls: UrlParts[] = [];
  const push = (url: UrlParts): void => {
    const key = formatUrl(url);
    if (!seen.has(key)) {
      seen.add(key);
      urls.push(url);
    }
  };
  for (const protocol of protocolList) {
    for (const host of hostList) {
      for (const port of portList) {
        push({ protocol, host, port });
      }
    }
  }
  for (const extra of options.extraUrls ?? []) push(extra);
  return { urls, hosts: hostList, protocols: protocolList, ports: portList };
}

export interface UrlCrossCheck {
  kind: "url-cross-check";
  universeSize: number;
  urlsChecked: number;
  mismatches: string[];
  ok: boolean;
}

// Verifies matchUrl(intersection, u) === matchUrl(a, u) && matchUrl(b, u)
// for every URL in the universe.
export function crossCheckIntersection(
  a: Rule,
  b: Rule,
  intersection: Rule,
  universe: UrlUniverse
): UrlCrossCheck {
  const mismatches: string[] = [];
  for (const url of universe.urls) {
    const expected = matchUrl(a, url) && matchUrl(b, url);
    if (matchUrl(intersection, url) !== expected) mismatches.push(formatUrl(url));
  }
  return {
    kind: "url-cross-check",
    universeSize: universe.urls.length,
    urlsChecked: universe.urls.length,
    mismatches,
    ok: mismatches.length === 0,
  };
}

// Verifies matchUrl(a, u) === matchUrl(b, u) for every URL in the universe.
export function crossCheckMatchEquality(
  a: Rule,
  b: Rule,
  universe: UrlUniverse
): UrlCrossCheck {
  const mismatches: string[] = [];
  for (const url of universe.urls) {
    if (matchUrl(a, url) !== matchUrl(b, url)) mismatches.push(formatUrl(url));
  }
  return {
    kind: "url-cross-check",
    universeSize: universe.urls.length,
    urlsChecked: universe.urls.length,
    mismatches,
    ok: mismatches.length === 0,
  };
}
