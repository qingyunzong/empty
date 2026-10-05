import { Policy, UrlParts } from "./types.js";
import { matchUrl } from "./policy.js";

// Finite small-domain universe used to cross-check matching semantics and
// to close the finite-state redirect-chain proof. It is derived from the
// domains, allow/exclude members, protocols and ports actually appearing
// in the involved policies, plus negative-coverage extras.

const EXTRA_SUBDOMAIN_LABELS = ["a", "www", "a.b", "b.www"];
const EXTRA_PORTS = [80, 443, 8080];
const EXTRA_PROTOCOL = "ftp";
const OUTSIDE_BASES = ["other.test"];
const MAX_BASES = 12;
const MAX_PREFIXES = 12;

function parentSuffixes(domain: string): string[] {
  const labels = domain.split(".");
  const out: string[] = [];
  for (let i = 0; i < labels.length; i++) out.push(labels.slice(i).join("."));
  return out;
}

function suffixesOfSub(sub: string): string[] {
  if (sub === "") return [];
  return parentSuffixes(sub);
}

export function buildUniverse(policies: Policy[]): UrlParts[] {
  const bases = new Set<string>();
  const prefixes = new Set<string>(["", ...EXTRA_SUBDOMAIN_LABELS]);
  const protocols = new Set<string>();
  const ports = new Set<number>(EXTRA_PORTS);

  for (const p of policies) {
    for (const proto of p.protocols) protocols.add(proto);
    if (p.ports !== null) for (const port of p.ports) ports.add(port);
    for (const e of p.entries) {
      for (const suffix of parentSuffixes(e.domain)) bases.add(suffix);
      for (const s of e.allow ?? []) {
        prefixes.add(s);
        for (const sfx of suffixesOfSub(s)) prefixes.add(sfx);
      }
      for (const s of e.exclude) {
        prefixes.add(s);
        for (const sfx of suffixesOfSub(s)) prefixes.add(sfx);
      }
    }
  }
  protocols.add(EXTRA_PROTOCOL);
  for (const b of OUTSIDE_BASES) bases.add(b);

  const baseList = [...bases].sort().slice(0, MAX_BASES);
  const prefixList = [...prefixes].sort().slice(0, MAX_PREFIXES);
  const protoList = [...protocols].sort();
  const portList: (number | null)[] = [null, ...[...ports].sort((x, y) => x - y)];

  const urls: UrlParts[] = [];
  for (const protocol of protoList) {
    for (const base of baseList) {
      for (const prefix of prefixList) {
        const host = prefix === "" ? base : `${prefix}.${base}`;
        for (const port of portList) {
          urls.push({ protocol, host, port });
        }
      }
    }
  }
  return urls;
}

export interface CrossCheckResult {
  universeSize: number;
  urlsChecked: number;
  mismatches: { url: string; intersection: boolean; sources: boolean }[];
}

export function formatUrl(u: UrlParts): string {
  return `${u.protocol}://${u.host}${u.port === null ? "" : `:${u.port}`}/`;
}

// For every URL in the finite universe, the intersection policy must accept
// exactly when both source policies accept.
export function crossCheck(a: Policy, b: Policy, intersection: Policy, universe: UrlParts[]): CrossCheckResult {
  const mismatches: CrossCheckResult["mismatches"] = [];
  for (const url of universe) {
    const byIntersection = matchUrl(intersection, url);
    const bySources = matchUrl(a, url) && matchUrl(b, url);
    if (byIntersection !== bySources && mismatches.length < 20) {
      mismatches.push({ url: formatUrl(url), intersection: byIntersection, sources: bySources });
    }
  }
  return { universeSize: universe.length, urlsChecked: universe.length, mismatches };
}
