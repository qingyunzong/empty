export type SameSite = "Strict" | "Lax" | "None";

export interface Cookie {
  name: string;
  value: string;
  /** Normalized (lowercase, no leading dot) domain the cookie belongs to. */
  domain: string;
  /** Host-only cookies are never sent to subdomains. */
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
  partitioned: boolean;
  /** Epoch ms at which the cookie expires, or null for a session cookie. */
  expiresAt: number | null;
  /** Creation sequence number; preserved across updates of the same cookie. */
  createdAt: number;
  /** Top-level site partition key, set only for Partitioned cookies. */
  partitionKey: string | null;
}

/** Maps a host name to its registrable site (e.g. eTLD+1). Injected by the caller. */
export type SiteForHost = (host: string) => string;

export interface CookieJarOptions {
  siteForHost: SiteForHost;
  /** Controllable clock, epoch ms. Defaults to Date.now. */
  now?: () => number;
}

export interface CookieContext {
  /** URL of the request being made. */
  requestUrl: string | URL;
  /** Top-level site: a URL or an already-computed site string. */
  topLevelSite: string | URL;
}

export interface SetCookieContext extends CookieContext {}

export interface GetCookieContext extends CookieContext {
  /** HTTP method of the request. Defaults to "GET". */
  method?: string;
  /** Whether the request is a top-level navigation. */
  isTopLevelNavigation?: boolean;
}

const UNPARTITIONED = "";

export class CookieJar {
  private readonly siteForHost: SiteForHost;
  private readonly now: () => number;
  private readonly cookies = new Map<string, Cookie>();
  private sequence = 0;

  constructor(options: CookieJarOptions) {
    this.siteForHost = options.siteForHost;
    this.now = options.now ?? (() => Date.now());
  }

  /** Parse and store a Set-Cookie header value. Returns the stored cookie, or null if rejected. */
  setCookie(header: string, context: SetCookieContext): Cookie | null {
    const url = toUrl(context.requestUrl);
    if (url === null) return null;
    const requestHost = url.hostname.toLowerCase();
    const secureTransport = url.protocol === "https:";
    const now = this.now();

    const parsed = parseSetCookie(header);
    if (parsed === null) return null;
    const { name, value, attributes } = parsed;

    // Domain (RFC6265 §5.2.3): strip leading dot, request host must domain-match it.
    let domain = requestHost;
    let hostOnly = true;
    const domainAttr = attributes.get("domain");
    if (domainAttr !== undefined && domainAttr !== "") {
      const candidate = domainAttr.replace(/^\.+/, "").toLowerCase();
      if (!domainMatch(requestHost, candidate)) return null;
      domain = candidate;
      hostOnly = false;
    }

    // Path (RFC6265 §5.2.4): default to the request URL's directory.
    let path: string;
    const pathAttr = attributes.get("path");
    if (pathAttr !== undefined && pathAttr.startsWith("/")) {
      path = pathAttr;
    } else {
      path = defaultPath(url.pathname);
    }

    const secure = attributes.has("secure");
    const httpOnly = attributes.has("httponly");
    const partitioned = attributes.has("partitioned");

    // Secure cookies are only accepted over HTTPS.
    if (secure && !secureTransport) return null;

    // SameSite: None requires Secure; unknown values fall back to Lax.
    let sameSite: SameSite = "Lax";
    const sameSiteAttr = attributes.get("samesite");
    if (sameSiteAttr !== undefined) {
      const normalized = sameSiteAttr.toLowerCase();
      if (normalized === "strict") sameSite = "Strict";
      else if (normalized === "none") sameSite = "None";
      else sameSite = "Lax";
    }
    if (sameSite === "None" && !secure) return null;

    // Partitioned (CHIPS): requires Secure, keyed by the top-level site.
    let partitionKey: string | null = null;
    if (partitioned) {
      if (!secure) return null;
      partitionKey = this.siteOf(context.topLevelSite);
    }

    // __Host- prefix: Secure, set from a secure origin, no Domain, Path=/.
    if (name.startsWith("__Host-")) {
      if (!secure || !secureTransport || !hostOnly || path !== "/") return null;
    }

    // Expiry: Max-Age takes precedence over Expires.
    let expiresAt: number | null = null;
    const maxAgeAttr = attributes.get("max-age");
    if (maxAgeAttr !== undefined && /^-?\d+$/.test(maxAgeAttr.trim())) {
      expiresAt = now + Number(maxAgeAttr.trim()) * 1000;
    } else {
      const expiresAttr = attributes.get("expires");
      if (expiresAttr !== undefined) {
        const parsedDate = Date.parse(expiresAttr);
        if (!Number.isNaN(parsedDate)) expiresAt = parsedDate;
      }
    }

    const key = storageKey(partitionKey ?? UNPARTITIONED, domain, path, name);
    const existing = this.cookies.get(key);

    // Already-expired cookies remove any existing entry instead of being stored.
    if (expiresAt !== null && expiresAt <= now) {
      this.cookies.delete(key);
      return null;
    }

    const cookie: Cookie = {
      name,
      value,
      domain,
      hostOnly,
      path,
      secure,
      httpOnly,
      sameSite,
      partitioned,
      expiresAt,
      // Updates preserve the original creation order.
      createdAt: existing ? existing.createdAt : this.sequence++,
      partitionKey,
    };
    this.cookies.set(key, cookie);
    return { ...cookie };
  }

  /** Cookies that would be sent with a request, sorted by longest path then creation order. */
  getCookies(context: GetCookieContext): Cookie[] {
    const url = toUrl(context.requestUrl);
    if (url === null) return [];
    const requestHost = url.hostname.toLowerCase();
    const requestPath = url.pathname || "/";
    const secureTransport = url.protocol === "https:";
    const method = (context.method ?? "GET").toUpperCase();
    const isTopLevelNavigation = context.isTopLevelNavigation ?? false;
    const now = this.now();
    const requestSite = this.siteForHost(requestHost);
    const topSite = this.siteOf(context.topLevelSite);
    const sameSite = requestSite === topSite;

    const matches: Cookie[] = [];
    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        this.cookies.delete(key);
        continue;
      }
      // Host-only cookies must not leak to subdomains.
      if (cookie.hostOnly) {
        if (requestHost !== cookie.domain) continue;
      } else if (!domainMatch(requestHost, cookie.domain)) {
        continue;
      }
      if (!pathMatch(requestPath, cookie.path)) continue;
      // Secure cookies only travel over HTTPS.
      if (cookie.secure && !secureTransport) continue;
      // Partitioned cookies are isolated by top-level site.
      if (cookie.partitioned && cookie.partitionKey !== topSite) continue;
      // SameSite enforcement.
      if (!sameSite) {
        if (cookie.sameSite === "Strict") continue;
        if (
          cookie.sameSite === "Lax" &&
          !(isTopLevelNavigation && method === "GET")
        ) {
          continue;
        }
      }
      matches.push({ ...cookie });
    }

    // Longest path first, then earliest created.
    matches.sort((a, b) => {
      if (b.path.length !== a.path.length) return b.path.length - a.path.length;
      return a.createdAt - b.createdAt;
    });
    return matches;
  }

  /** Value for a Cookie request header. */
  getCookieHeader(context: GetCookieContext): string {
    return this.getCookies(context)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  /** Number of live (unexpired) cookies currently stored. */
  get size(): number {
    this.purgeExpired();
    return this.cookies.size;
  }

  clear(): void {
    this.cookies.clear();
  }

  private siteOf(topLevelSite: string | URL): string {
    if (topLevelSite instanceof URL) {
      return this.siteForHost(topLevelSite.hostname.toLowerCase());
    }
    const asUrl = tryParseUrl(topLevelSite);
    if (asUrl !== null && asUrl.hostname !== "") {
      return this.siteForHost(asUrl.hostname.toLowerCase());
    }
    return topLevelSite;
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        this.cookies.delete(key);
      }
    }
  }
}

function storageKey(
  partitionKey: string,
  domain: string,
  path: string,
  name: string,
): string {
  return `${partitionKey} ${domain} ${path} ${name}`;
}

function toUrl(input: string | URL): URL | null {
  if (input instanceof URL) return input;
  return tryParseUrl(input);
}

function tryParseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

/** RFC6265 §5.1.3 domain matching. */
export function domainMatch(host: string, domain: string): boolean {
  if (host === domain) return true;
  return host.endsWith(`.${domain}`) && !isIpAddress(host);
}

/** RFC6265 §5.1.4 path matching. */
export function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (requestPath.startsWith(cookiePath)) {
    if (cookiePath.endsWith("/")) return true;
    if (requestPath.charAt(cookiePath.length) === "/") return true;
  }
  return false;
}

/** RFC6265 §5.2.4 default path: the request path up to its last "/". */
export function defaultPath(pathname: string): string {
  if (!pathname.startsWith("/")) return "/";
  const lastSlash = pathname.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return pathname.slice(0, lastSlash);
}

function isIpAddress(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(":");
}

interface ParsedSetCookie {
  name: string;
  value: string;
  attributes: Map<string, string>;
}

/** RFC6265 §5.2 parsing of a Set-Cookie header value. */
function parseSetCookie(header: string): ParsedSetCookie | null {
  const parts = header.split(";");
  const first = parts[0];
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (name === "") return null;

  const attributes = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const attrEq = part.indexOf("=");
    if (attrEq === -1) {
      const flag = part.trim().toLowerCase();
      if (flag !== "") attributes.set(flag, "");
    } else {
      const attrName = part.slice(0, attrEq).trim().toLowerCase();
      const attrValue = part.slice(attrEq + 1).trim();
      if (attrName !== "" && !attributes.has(attrName)) {
        attributes.set(attrName, attrValue);
      }
    }
  }
  return { name, value, attributes };
}
