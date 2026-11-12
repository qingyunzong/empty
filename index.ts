/**
 * 抓取缓存的年龄与新鲜度判定。
 *
 * 纯本地计算：不发起任何网络请求，不修改任何入参，同一输入恒得同一结果。
 * 所有时刻、年龄、寿命均为整数秒，全部比较都基于精确整数运算。
 */

/** 缓存种类：共享缓存或私有缓存。 */
export type CacheKind = "shared" | "private";

/** 有序的 HTTP 头；名字按 ASCII 规则忽略大小写比较，值保持原样。 */
export interface Header {
  name: string;
  value: string;
}

/** 一次新请求。 */
export interface CacheRequest {
  method: string;
  headers: Header[];
}

/** 调度器保存下来的响应条目，含当时的原始请求与整数时刻。 */
export interface StoredResponse {
  status: number;
  headers: Header[];
  /** 产生该保存响应的原始请求，Vary 匹配时使用。 */
  storedRequest: CacheRequest;
  /** 响应时刻（整数秒）。 */
  responseTime: number;
  /** 触发该响应的请求时刻（整数秒）。 */
  requestTime: number;
}

/** 一次缓存判定的输入。 */
export interface LookupInput {
  request: CacheRequest;
  stored: StoredResponse;
  /** 当前时刻（整数秒）。 */
  now: number;
}

/** 缓存判定结论。 */
export type Decision = "fresh" | "stale" | "revalidate" | "miss";

/** 判定结果；硬未命中时四个数字字段为空（null）。 */
export interface CacheVerdict {
  decision: Decision;
  /** 当前年龄 current_age。 */
  age: number | null;
  /** 新鲜寿命 freshness_lifetime。 */
  lifetime: number | null;
  /** max(0, 当前年龄 - 寿命)。 */
  staleFor: number | null;
  /** max(0, need - 寿命)。 */
  needOverLifetime: number | null;
  /** 机器可读的原因码，便于调用方记录日志。 */
  reason: string;
}

const MAX_DELTA = 2147483647;

const DEFAULT_CACHEABLE_STATUSES: ReadonlySet<number> = new Set([
  200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501,
]);

const HEURISTIC_STATUSES: ReadonlySet<number> = new Set([200, 203, 204, 206]);

const MONTHS: Readonly<Record<string, number>> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const IMF_DATE_RE =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;

/** 按 ASCII 规则把单个字符转为小写（仅 A-Z 受影响）。 */
function asciiLower(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

/** 按 ASCII 规则比较两个名字，忽略大小写。 */
function nameEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (asciiLower(a.charCodeAt(index)) !== asciiLower(b.charCodeAt(index))) {
      return false;
    }
  }
  return true;
}

/** 取名字匹配的全部头值（保持出现顺序），不修改入参。 */
function getHeaderValues(headers: readonly Header[], name: string): string[] {
  const values: string[] = [];
  for (const header of headers) {
    if (nameEquals(header.name, name)) {
      values.push(header.value);
    }
  }
  return values;
}

/** 取名字匹配的第一个头值；没有则返回 null。 */
function getFirstHeader(headers: readonly Header[], name: string): string | null {
  const values = getHeaderValues(headers, name);
  return values.length === 0 ? null : values[0];
}

/**
 * 解析 delta-seconds：允许前导零，范围 0..2147483647。
 * 非纯数字、带引号、空格或越界都视为非法，返回 null。
 */
function parseDeltaSeconds(raw: string): number | null {
  if (raw.length === 0 || raw.length > 10 || !/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DELTA) {
    return null;
  }
  return value;
}

/** 把 Cache-Control 各头按出现顺序用逗号拼接。 */
function joinCacheControl(headers: readonly Header[]): string {
  return getHeaderValues(headers, "Cache-Control").join(",");
}

/**
 * 按逗号切分指令：双引号内的逗号不分隔；
 * 引号内反斜杠转义后一字符；引号不闭合返回 null（未命中）。
 */
function splitDirectives(joined: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < joined.length; index += 1) {
    const char = joined[index];
    if (inQuotes) {
      if (char === "\\") {
        current += char;
        const next = joined[index + 1];
        if (next !== undefined) {
          current += next;
          index += 1;
        }
      } else if (char === '"') {
        inQuotes = false;
        current += char;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
      current += char;
    } else if (char === ",") {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (inQuotes) {
    return null;
  }
  parts.push(current);
  return parts;
}

/** 解析后的 Cache-Control；数值非法由 invalid 标记，导致未命中。 */
interface ParsedCacheControl {
  publicPresent: boolean;
  privatePresent: boolean;
  noCachePresent: boolean;
  noStorePresent: boolean;
  mustRevalidatePresent: boolean;
  proxyRevalidatePresent: boolean;
  maxAge: number | null;
  sMaxAge: number | null;
  minFresh: number | null;
  /** 无值的 max-stale 表示可接受任意陈旧（Infinity）。 */
  maxStale: number | null;
  maxStaleInfinite: boolean;
  onlyIfCachedPresent: boolean;
  invalid: boolean;
}

const EMPTY_CACHE_CONTROL: ParsedCacheControl = {
  publicPresent: false,
  privatePresent: false,
  noCachePresent: false,
  noStorePresent: false,
  mustRevalidatePresent: false,
  proxyRevalidatePresent: false,
  maxAge: null,
  sMaxAge: null,
  minFresh: null,
  maxStale: null,
  maxStaleInfinite: false,
  onlyIfCachedPresent: false,
  invalid: false,
};

/**
 * 解析 Cache-Control。
 * 未知指令忽略；重复指令只取第一个，第一个值非法则未命中。
 */
function parseCacheControl(headers: readonly Header[]): ParsedCacheControl | null {
  const joined = joinCacheControl(headers);
  const pieces = splitDirectives(joined);
  if (pieces === null) {
    return null;
  }
  const parsed: ParsedCacheControl = { ...EMPTY_CACHE_CONTROL };
  const seen = new Set<string>();

  for (const piece of pieces) {
    const token = piece.trim();
    if (token.length === 0) {
      continue;
    }
    const equalIndex = token.indexOf("=");
    const rawName = (equalIndex === -1 ? token : token.slice(0, equalIndex)).trim();
    const hasValue = equalIndex !== -1;
    const rawValue = hasValue ? token.slice(equalIndex + 1).trim() : "";
    const name = rawName.toLowerCase();

    switch (name) {
      case "public":
        if (!seen.has(name)) {
          parsed.publicPresent = true;
          seen.add(name);
        }
        break;
      case "private":
        if (!seen.has(name)) {
          parsed.privatePresent = true;
          seen.add(name);
        }
        break;
      case "no-cache":
        if (!seen.has(name)) {
          parsed.noCachePresent = true;
          seen.add(name);
        }
        break;
      case "no-store":
        if (!seen.has(name)) {
          parsed.noStorePresent = true;
          seen.add(name);
        }
        break;
      case "must-revalidate":
        if (!seen.has(name)) {
          parsed.mustRevalidatePresent = true;
          seen.add(name);
        }
        break;
      case "proxy-revalidate":
        if (!seen.has(name)) {
          parsed.proxyRevalidatePresent = true;
          seen.add(name);
        }
        break;
      case "only-if-cached":
        if (!seen.has(name)) {
          parsed.onlyIfCachedPresent = true;
          seen.add(name);
        }
        break;
      case "max-age":
      case "s-maxage":
      case "min-fresh":
      case "max-stale": {
        if (seen.has(name)) {
          break;
        }
        seen.add(name);
        if (name === "max-stale" && !hasValue) {
          parsed.maxStaleInfinite = true;
          break;
        }
        const value = parseDeltaSeconds(rawValue);
        if (value === null) {
          parsed.invalid = true;
          break;
        }
        if (name === "max-age") {
          parsed.maxAge = value;
        } else if (name === "s-maxage") {
          parsed.sMaxAge = value;
        } else if (name === "min-fresh") {
          parsed.minFresh = value;
        } else {
          parsed.maxStale = value;
        }
        break;
      }
      default:
        // 未知指令忽略。
        break;
    }
  }

  return parsed;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) {
    return 30;
  }
  return 31;
}

function floorMod(value: number, divisor: number): number {
  const remainder = value % divisor;
  return remainder < 0 ? remainder + divisor : remainder;
}

/**
 * 公历日期转自 1970-01-01 00:00:00 UTC 起的天数（可为负）。
 * 采用 Howard Hinnant 的 daysFromCivil 公式，floor 除法对任意整数年份成立。
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month > 2 ? month - 3 : month + 9;
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/**
 * 仅接受 IMF-fixdate："Sun, 06 Nov 1994 08:49:37 GMT"。
 * 星期必须与公历一致；非法日期或星期返回 null（按缺失处理）。
 */
function parseImfDate(raw: string): number | null {
  const match = IMF_DATE_RE.exec(raw);
  if (match === null) {
    return null;
  }
  const [, weekdayName, dayText, monthName, yearText, hourText, minuteText, secondText] = match;
  const day = Number(dayText);
  const month = MONTHS[monthName];
  const year = Number(yearText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);

  if (month === undefined) {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    return null;
  }

  const days = daysFromCivil(year, month, day);
  const weekday = floorMod(days + 4, 7); // 1970-01-01 为星期四（索引 4）。
  if (WEEKDAYS[weekday] !== weekdayName) {
    return null;
  }
  return days * 86400 + hour * 3600 + minute * 60 + second;
}

/** 单个日期字段：无法解析或缺失都返回 null。 */
function parseSingleDate(headers: readonly Header[], name: string): number | null {
  const raw = getFirstHeader(headers, name);
  if (raw === null) {
    return null;
  }
  return parseImfDate(raw);
}

/**
 * 校验 Vary：含星号返回 false（未命中）；
 * 其余字段把新旧请求同名头的全部原始值按序用逗号直接连接后区分大小写比较，
 * 缺头视为空串。
 */
function varyMatches(stored: StoredResponse, request: CacheRequest): boolean {
  const varyValues = getHeaderValues(stored.headers, "Vary");
  for (const varyValue of varyValues) {
    const fields = varyValue.split(",");
    for (const field of fields) {
      const fieldName = field.trim();
      if (fieldName === "*") {
        return false;
      }
      if (fieldName.length === 0) {
        continue;
      }
      const storedJoined = getHeaderValues(stored.storedRequest.headers, fieldName).join(",");
      const requestJoined = getHeaderValues(request.headers, fieldName).join(",");
      if (storedJoined !== requestJoined) {
        return false;
      }
    }
  }
  return true;
}

/** 硬未命中：四个数字字段一律为空。 */
function hardMiss(reason: string): CacheVerdict {
  return {
    decision: "miss",
    age: null,
    lifetime: null,
    staleFor: null,
    needOverLifetime: null,
    reason,
  };
}

/**
 * 缓存新鲜度判定器。
 *
 * 构造时给出缓存种类（共享/私有）与是否允许启发式寿命；
 * 每次调用 decide 都基于传入条目独立计算，不发网络请求、不修改入参。
 */
export class CacheDecider {
  private readonly shared: boolean;
  private readonly allowHeuristic: boolean;

  constructor(kind: CacheKind, allowHeuristicLifetime: boolean) {
    this.shared = kind === "shared";
    this.allowHeuristic = allowHeuristicLifetime;
  }

  decide(input: LookupInput): CacheVerdict {
    const { request, stored, now } = input;
    const responseHeaders = stored.headers;

    // 仅 GET/HEAD 可能命中：保存的 GET 可满足 GET/HEAD，保存的 HEAD 只满足 HEAD。
    const requestMethod = request.method.toUpperCase();
    const storedMethod = stored.storedRequest.method.toUpperCase();
    if (requestMethod !== "GET" && requestMethod !== "HEAD") {
      return hardMiss("miss-method-not-cacheable");
    }
    if (storedMethod !== "GET" && storedMethod !== "HEAD") {
      return hardMiss("miss-stored-method-not-cacheable");
    }
    if (storedMethod === "HEAD" && requestMethod !== "HEAD") {
      return hardMiss("miss-head-cannot-serve-get");
    }

    const requestControl = parseCacheControl(request.headers);
    if (requestControl === null) {
      return hardMiss("miss-malformed-request-cache-control");
    }
    if (requestControl.invalid) {
      return hardMiss("miss-invalid-request-cache-control-directive");
    }
    if (requestControl.noStorePresent) {
      return hardMiss("miss-request-no-store");
    }

    const responseControl = parseCacheControl(responseHeaders);
    if (responseControl === null) {
      return hardMiss("miss-malformed-response-cache-control");
    }
    if (responseControl.invalid) {
      return hardMiss("miss-invalid-response-cache-control-directive");
    }
    if (responseControl.noStorePresent) {
      return hardMiss("miss-response-no-store");
    }
    // 共享缓存遇到无论是否带字段列表的 private 都未命中；私有缓存接受 private。
    if (this.shared && responseControl.privatePresent) {
      return hardMiss("miss-response-private");
    }

    // 多个 Age 未命中；Age 必须是单个 delta-seconds。
    const ageValues = getHeaderValues(responseHeaders, "Age");
    if (ageValues.length > 1) {
      return hardMiss("miss-multiple-age");
    }
    let ageValue: number | null = null;
    if (ageValues.length === 1) {
      ageValue = parseDeltaSeconds(ageValues[0]);
      if (ageValue === null) {
        return hardMiss("miss-invalid-age");
      }
    }

    // 多个 Date 未命中。
    if (getHeaderValues(responseHeaders, "Date").length > 1) {
      return hardMiss("miss-multiple-date");
    }

    // 时刻健全性：响应时刻小于请求时刻，或 now 小于响应时刻，都未命中。
    if (stored.responseTime < stored.requestTime) {
      return hardMiss("miss-response-before-request");
    }
    if (now < stored.responseTime) {
      return hardMiss("miss-now-before-response");
    }

    // Vary：含星号或字段值不一致都未命中。
    if (!varyMatches(stored, request)) {
      return hardMiss("miss-vary-mismatch");
    }

    // 默认可缓存状态之外，需要 public、max-age，或共享缓存下合法的 s-maxage。
    const explicitlyCacheable =
      responseControl.publicPresent ||
      responseControl.maxAge !== null ||
      (this.shared && responseControl.sMaxAge !== null);
    if (!DEFAULT_CACHEABLE_STATUSES.has(stored.status) && !explicitlyCacheable) {
      return hardMiss("miss-status-not-cacheable");
    }

    // 日期字段：单个字段无法解析就当缺失。
    const responseDate = parseSingleDate(responseHeaders, "Date");
    const expiresDate = parseSingleDate(responseHeaders, "Expires");
    const lastModifiedDate = parseSingleDate(responseHeaders, "Last-Modified");

    // apparent = 有 Date 时 max(0, 响应时刻 - Date)，否则 0。
    const apparentAge =
      responseDate === null ? 0 : Math.max(0, stored.responseTime - responseDate);
    // corrected = Age（缺失按 0）+ 响应时刻 - 请求时刻。
    const correctedAge =
      (ageValue ?? 0) + (stored.responseTime - stored.requestTime);
    // 初始年龄取二者较大值；当前年龄再加 now - 响应时刻。
    const currentAge =
      Math.max(apparentAge, correctedAge) + (now - stored.responseTime);

    const lifetime = this.resolveLifetime(
      responseControl,
      stored.status,
      responseDate,
      expiresDate,
      lastModifiedDate,
    );

    // need = 当前年龄 + min-fresh（没有则加 0）。
    const need = currentAge + (requestControl.minFresh ?? 0);

    let decision: Decision;
    let reason: string;
    if (responseControl.noCachePresent) {
      decision = "revalidate";
      reason = "revalidate-response-no-cache";
    } else if (requestControl.noCachePresent) {
      decision = "revalidate";
      reason = "revalidate-request-no-cache";
    } else if (responseControl.mustRevalidatePresent) {
      decision = "revalidate";
      reason = "revalidate-must-revalidate";
    } else if (this.shared && responseControl.proxyRevalidatePresent) {
      decision = "revalidate";
      reason = "revalidate-proxy-revalidate";
    } else if (need <= lifetime) {
      decision = "fresh";
      reason = "fresh-within-lifetime";
    } else if (
      requestControl.maxStaleInfinite ||
      (requestControl.maxStale !== null &&
        need <= lifetime + requestControl.maxStale)
    ) {
      // 已接受的 stale；上面的强制 revalidate 不会走到这里。
      decision = "stale";
      reason = "stale-allowed-by-max-stale";
    } else {
      decision = "revalidate";
      reason = "revalidate-stale-without-permission";
    }

    // only-if-cached 只把 revalidate 改为 miss，fresh 与已接受的 stale 不变。
    if (decision === "revalidate" && requestControl.onlyIfCachedPresent) {
      decision = "miss";
      reason = "miss-only-if-cached";
    }

    // revalidate 既无非空 ETag 也无有效 Last-Modified，则改为 miss。
    if (decision === "revalidate") {
      const etag = getFirstHeader(responseHeaders, "ETag");
      const hasValidator =
        (etag !== null && etag.length > 0) || lastModifiedDate !== null;
      if (!hasValidator) {
        decision = "miss";
        reason = "miss-no-validator";
      }
    }

    return {
      decision,
      age: currentAge,
      lifetime,
      staleFor: Math.max(0, currentAge - lifetime),
      needOverLifetime: Math.max(0, need - lifetime),
      reason,
    };
  }

  /** 按规定顺序决定寿命，全部为整数运算。 */
  private resolveLifetime(
    control: ParsedCacheControl,
    status: number,
    responseDate: number | null,
    expiresDate: number | null,
    lastModifiedDate: number | null,
  ): number {
    if (this.shared && control.sMaxAge !== null) {
      return control.sMaxAge;
    }
    if (control.maxAge !== null) {
      return control.maxAge;
    }
    if (responseDate !== null && expiresDate !== null) {
      return Math.max(0, expiresDate - responseDate);
    }
    if (
      this.allowHeuristic &&
      HEURISTIC_STATUSES.has(status) &&
      responseDate !== null &&
      lastModifiedDate !== null &&
      lastModifiedDate <= responseDate
    ) {
      return Math.floor((responseDate - lastModifiedDate) / 10);
    }
    return 0;
  }
}

/** 便捷函数：一次性构造判定器并给出结论。 */
export function decideCache(
  kind: CacheKind,
  allowHeuristicLifetime: boolean,
  input: LookupInput,
): CacheVerdict {
  return new CacheDecider(kind, allowHeuristicLifetime).decide(input);
}
