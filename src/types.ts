// Core policy model.
//
// A Policy matches a URL when:
//   - the URL protocol is in `protocols`
//   - the URL port is in `ports` (`null` = any port)
//   - the URL host matches at least one DomainEntry:
//       * exact:    host === domain, subdomain part is ""
//       * wildcard: host === "<sub>.<domain>" with a NON-EMPTY <sub>
//                   (a wildcard never matches its root domain)
//     and the subdomain part passes the entry's allow/exclude sets:
//       * allow === null            -> unrestricted
//       * allow === [...]           -> sub must be listed
//       * sub must not be in exclude
//
// `redirectBudget` bounds the number of redirects (chain length - 1);
// `null` means unbounded, which makes finite-state checks unclosable.

export interface DomainEntry {
  kind: "exact" | "wildcard";
  domain: string; // exact host, or wildcard base (no "*." prefix)
  allow: string[] | null; // null = unrestricted
  exclude: string[];
}

export interface Policy {
  name: string;
  protocols: string[];
  ports: number[] | null; // null = any port
  entries: DomainEntry[];
  redirectBudget: number | null; // null = unbounded
}

export interface PolicyInput {
  name?: string;
  protocols?: string[];
  exactDomains?: string[];
  wildcardDomains?: string[];
  ports?: number[];
  allowSubdomains?: string[];
  excludeSubdomains?: string[];
  redirectBudget?: number | null;
}

export interface UrlParts {
  protocol: string; // without trailing ":"
  host: string;
  port: number | null; // null = scheme default
}

export function fail(message: string): never {
  throw new Error(message);
}

function normalizeDomain(raw: string, what: string): string {
  if (typeof raw !== "string") fail(`${what}: domain must be a string`);
  let d = raw.trim().toLowerCase();
  if (d.startsWith("*.")) d = d.slice(2);
  if (d.endsWith(".")) d = d.slice(0, -1);
  if (d.length === 0) fail(`${what}: empty domain`);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(d)) {
    fail(`${what}: invalid domain ${JSON.stringify(raw)}`);
  }
  return d;
}

function normalizeSubdomain(raw: string, what: string): string {
  if (typeof raw !== "string") fail(`${what}: subdomain must be a string`);
  const s = raw.trim().toLowerCase().replace(/\.$/, "");
  if (s !== "" && !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(s)) {
    fail(`${what}: invalid subdomain ${JSON.stringify(raw)}`);
  }
  return s;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sortedUniqueNums(values: number[]): number[] {
  return [...new Set(values)].sort((x, y) => x - y);
}

export function normalizePolicy(input: PolicyInput, fallbackName: string): Policy {
  if (typeof input !== "object" || input === null) fail("policy must be an object");
  const name = typeof input.name === "string" ? input.name : fallbackName;

  const protocols = sortedUnique(
    (input.protocols ?? []).map((p) => {
      if (typeof p !== "string" || !/^[a-z][a-z0-9+.-]*$/i.test(p)) {
        fail(`policy ${name}: invalid protocol ${JSON.stringify(p)}`);
      }
      return p.toLowerCase();
    })
  );
  if (protocols.length === 0) fail(`policy ${name}: protocols must be non-empty`);

  let ports: number[] | null = null;
  if (input.ports !== undefined && input.ports !== null && input.ports.length > 0) {
    ports = sortedUniqueNums(
      input.ports.map((p) => {
        if (!Number.isInteger(p) || p < 1 || p > 65535) {
          fail(`policy ${name}: invalid port ${JSON.stringify(p)}`);
        }
        return p;
      })
    );
  }

  let redirectBudget: number | null = null;
  if (input.redirectBudget !== undefined && input.redirectBudget !== null) {
    const b = input.redirectBudget;
    if (!Number.isInteger(b) || b < 0) {
      fail(`policy ${name}: redirectBudget must be a non-negative integer or null`);
    }
    redirectBudget = b;
  }

  const allow =
    input.allowSubdomains && input.allowSubdomains.length > 0
      ? sortedUnique(input.allowSubdomains.map((s) => normalizeSubdomain(s, `policy ${name} allowSubdomains`)))
      : null;
  const exclude = sortedUnique(
    (input.excludeSubdomains ?? []).map((s) => normalizeSubdomain(s, `policy ${name} excludeSubdomains`))
  );

  const entries: DomainEntry[] = [];
  for (const d of input.exactDomains ?? []) {
    entries.push({ kind: "exact", domain: normalizeDomain(d, `policy ${name} exactDomains`), allow, exclude });
  }
  for (const d of input.wildcardDomains ?? []) {
    entries.push({ kind: "wildcard", domain: normalizeDomain(d, `policy ${name} wildcardDomains`), allow, exclude });
  }
  if (entries.length === 0) fail(`policy ${name}: at least one domain rule is required`);

  return { name, protocols, ports, entries: canonicalEntries(entries), redirectBudget };
}

// Union-merge entries that share kind+domain, drop dead allow members, sort.
export function canonicalEntries(entries: DomainEntry[]): DomainEntry[] {
  const byKey = new Map<string, DomainEntry>();
  for (const e of entries) {
    const allow = e.allow === null ? null : sortedUnique(e.allow.filter((s) => !e.exclude.includes(s)));
    const exclude = sortedUnique(e.exclude);
    const key = `${e.kind} ${e.domain}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { kind: e.kind, domain: e.domain, allow, exclude });
    } else {
      byKey.set(key, {
        kind: e.kind,
        domain: e.domain,
        allow: prev.allow === null || allow === null ? null : sortedUnique([...prev.allow, ...allow]),
        exclude: sortedUnique(prev.exclude.filter((s) => exclude.includes(s))),
      });
    }
  }
  return [...byKey.values()].sort((x, y) =>
    x.kind === y.kind ? x.domain.localeCompare(y.domain) : x.kind === "exact" ? -1 : 1
  );
}

const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, ws: 80, wss: 443, ftp: 21 };

export function defaultPort(protocol: string): number | null {
  return DEFAULT_PORTS[protocol] ?? null;
}

export function parseUrl(raw: string): UrlParts {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return fail(`invalid URL ${JSON.stringify(raw)}`);
  }
  const protocol = u.protocol.replace(/:$/, "").toLowerCase();
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const port = u.port === "" ? null : Number(u.port);
  return { protocol, host, port };
}
