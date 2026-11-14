export type IntegerRule = {
  type: 'integer';
  name: string;
  range: readonly [number, number];
  digits?: number;
};

export type DateUnit = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second';

export type DateRule = {
  type: 'date';
  name: string;
  range: readonly [string, string];
  format: string;
  interval?: number;
  intervalUnit?: DateUnit;
  timezone?: string;
};

export type EnumRule = {
  type: 'enum';
  name: string;
  values: readonly string[];
};

export type InjectedRule = {
  type: 'injected';
  name: string;
};

export type PartitionRule = IntegerRule | DateRule | EnumRule | InjectedRule;

export type Predicate =
  | { op: 'eq'; value: string | number }
  | { op: 'in'; values: readonly (string | number)[] }
  | { op: 'range'; min?: string | number; max?: string | number };

export type Predicates = Record<string, Predicate>;

export type ProjectOptions = {
  template?: string;
  maxPaths?: number;
};

export type Projection = {
  closed: boolean;
  paths: string[];
  reason?: string;
};

export type PartitionValues = Record<string, string | number>;

const DEFAULT_MAX_PATHS = 1000;
const HARD_STEP_LIMIT = 1_000_000;
const DATE_TOKEN_RE = /yyyy|MM|dd|HH|mm|ss/g;

type WallParts = { y: number; mo: number; d: number; h: number; mi: number; s: number };

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

function instantToWall(timeZone: string, utcMs: number): WallParts {
  const parts = zonedFormatter(timeZone).formatToParts(utcMs);
  const take = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Intl part "${type}" unavailable for zone ${timeZone}`);
    return Number(part.value);
  };
  return {
    y: take('year'),
    mo: take('month'),
    d: take('day'),
    h: take('hour') % 24,
    mi: take('minute'),
    s: take('second'),
  };
}

function wallToMs(parts: WallParts): number {
  return Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s);
}

function zoneOffsetMs(timeZone: string, utcMs: number): number {
  return wallToMs(instantToWall(timeZone, utcMs)) - utcMs;
}

function wallToInstant(timeZone: string, parts: WallParts): number {
  const guess = wallToMs(parts);
  let utc = guess - zoneOffsetMs(timeZone, guess);
  const refined = guess - zoneOffsetMs(timeZone, utc);
  if (refined !== utc) utc = refined;
  const roundTrip = wallToMs(instantToWall(timeZone, utc));
  if (roundTrip !== guess) utc += guess - roundTrip;
  return utc;
}

function stepWall(parts: WallParts, amount: number, unit: DateUnit): WallParts {
  const ms = Date.UTC(
    parts.y + (unit === 'year' ? amount : 0),
    parts.mo - 1 + (unit === 'month' ? amount : 0),
    parts.d + (unit === 'day' ? amount : 0),
    parts.h + (unit === 'hour' ? amount : 0),
    parts.mi + (unit === 'minute' ? amount : 0),
    parts.s + (unit === 'second' ? amount : 0),
  );
  const d = new Date(ms);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
}

function formatWall(parts: WallParts, format: string): string {
  return format.replace(DATE_TOKEN_RE, (token) => {
    switch (token) {
      case 'yyyy':
        return String(parts.y).padStart(4, '0');
      case 'MM':
        return String(parts.mo).padStart(2, '0');
      case 'dd':
        return String(parts.d).padStart(2, '0');
      case 'HH':
        return String(parts.h).padStart(2, '0');
      case 'mm':
        return String(parts.mi).padStart(2, '0');
      case 'ss':
        return String(parts.s).padStart(2, '0');
      default:
        return token;
    }
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseDateSegment(rule: DateRule, segment: string): number | null {
  const fields: string[] = [];
  const source = escapeRegExp(rule.format).replace(DATE_TOKEN_RE, (token) => {
    fields.push(token);
    return token === 'yyyy' ? '(\\d{1,6})' : '(\\d{1,2})';
  });
  const match = new RegExp(`^${source}$`).exec(segment);
  if (!match) return null;
  const parts: WallParts = { y: 1970, mo: 1, d: 1, h: 0, mi: 0, s: 0 };
  fields.forEach((token, i) => {
    const value = Number(match[i + 1]);
    if (token === 'yyyy') parts.y = value;
    else if (token === 'MM') parts.mo = value;
    else if (token === 'dd') parts.d = value;
    else if (token === 'HH') parts.h = value;
    else if (token === 'mm') parts.mi = value;
    else if (token === 'ss') parts.s = value;
  });
  if (parts.mo < 1 || parts.mo > 12 || parts.d < 1 || parts.d > 31) return null;
  if (parts.h > 23 || parts.mi > 59 || parts.s > 60) return null;
  return wallToInstant(rule.timezone ?? 'UTC', parts);
}

const EXPLICIT_OFFSET_RE = /(z|[+-]\d{2}:?\d{2})$/i;
const PLAIN_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?)?$/;

function parseDateValue(value: string | number, timeZone: string, ruleName: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`date value for "${ruleName}" is not finite`);
    }
    return value;
  }
  const text = value.trim();
  if (EXPLICIT_OFFSET_RE.test(text)) {
    const ms = Date.parse(text);
    if (Number.isNaN(ms)) {
      throw new TypeError(`date value "${value}" for "${ruleName}" is not parseable`);
    }
    return ms;
  }
  const match = PLAIN_DATE_RE.exec(text);
  if (match) {
    return wallToInstant(timeZone, {
      y: Number(match[1]),
      mo: Number(match[2]),
      d: Number(match[3]),
      h: Number(match[4] ?? 0),
      mi: Number(match[5] ?? 0),
      s: Number(match[6] ?? 0),
    });
  }
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) {
    throw new TypeError(`date value "${value}" for "${ruleName}" is not parseable`);
  }
  return ms;
}

function dateInstants(rule: DateRule): number[] {
  const timeZone = rule.timezone ?? 'UTC';
  const interval = rule.interval ?? 1;
  const unit = rule.intervalUnit ?? 'day';
  if (!Number.isInteger(interval) || interval < 1) {
    throw new TypeError(`date rule "${rule.name}" requires a positive integer interval`);
  }
  const startMs = parseDateValue(rule.range[0], timeZone, rule.name);
  const endMs = parseDateValue(rule.range[1], timeZone, rule.name);
  const instants: number[] = [];
  let wall = instantToWall(timeZone, startMs);
  for (let i = 0; i < HARD_STEP_LIMIT; i += 1) {
    const instant = wallToInstant(timeZone, wall);
    if (instant > endMs) break;
    instants.push(instant);
    wall = stepWall(wall, interval, unit);
  }
  return instants;
}

function toInstantMs(value: string | number, rule: DateRule): number {
  return parseDateValue(value, rule.timezone ?? 'UTC', rule.name);
}

function integerDomain(rule: IntegerRule, pred?: Predicate): number[] {
  const [lo, hi] = rule.range;
  let values: number[] = [];
  for (let v = lo; v <= hi; v += 1) values.push(v);
  if (!pred) return values;
  if (pred.op === 'eq') {
    const v = Number(pred.value);
    return values.includes(v) ? [v] : [];
  }
  if (pred.op === 'in') {
    const wanted = new Set(pred.values.map((v) => Number(v)));
    return values.filter((v) => wanted.has(v));
  }
  const min = pred.min === undefined ? lo : Math.ceil(Number(pred.min));
  const max = pred.max === undefined ? hi : Math.floor(Number(pred.max));
  return values.filter((v) => v >= min && v <= max);
}

function dateDomain(rule: DateRule, pred?: Predicate): number[] {
  const instants = dateInstants(rule);
  if (!pred) return instants;
  if (pred.op === 'eq') {
    const target = toInstantMs(pred.value, rule);
    return instants.includes(target) ? [target] : [];
  }
  if (pred.op === 'in') {
    const wanted = new Set(pred.values.map((v) => toInstantMs(v, rule)));
    return instants.filter((ms) => wanted.has(ms));
  }
  const min = pred.min === undefined ? -Infinity : toInstantMs(pred.min, rule);
  const max = pred.max === undefined ? Infinity : toInstantMs(pred.max, rule);
  return instants.filter((ms) => ms >= min && ms <= max);
}

function enumDomain(rule: EnumRule, pred?: Predicate): string[] {
  if (!pred) return [...rule.values];
  if (pred.op === 'eq') {
    const v = String(pred.value);
    return rule.values.includes(v) ? [v] : [];
  }
  if (pred.op === 'in') {
    const wanted = new Set(pred.values.map((v) => String(v)));
    return rule.values.filter((v) => wanted.has(v));
  }
  throw new TypeError(`enum rule "${rule.name}" does not support range predicates`);
}

function injectedDomain(rule: InjectedRule, pred?: Predicate): string[] | null {
  if (!pred) return null;
  if (pred.op === 'eq') return [String(pred.value)];
  if (pred.op === 'in') return pred.values.map((v) => String(v));
  throw new TypeError(`injected rule "${rule.name}" does not support range predicates`);
}

function columnDomain(rule: PartitionRule, pred?: Predicate): (string | number)[] | null {
  switch (rule.type) {
    case 'integer':
      return integerDomain(rule, pred);
    case 'date':
      return dateDomain(rule, pred);
    case 'enum':
      return enumDomain(rule, pred);
    case 'injected':
      return injectedDomain(rule, pred);
  }
}

function segmentFor(rule: PartitionRule, value: string | number): string {
  switch (rule.type) {
    case 'integer': {
      const digits = rule.digits ?? 0;
      const num = Number(value);
      const text = String(Math.abs(num)).padStart(digits, '0');
      return num < 0 ? `-${text}` : text;
    }
    case 'date':
      return formatWall(instantToWall(rule.timezone ?? 'UTC', Number(value)), rule.format);
    case 'enum':
    case 'injected':
      return String(value);
  }
}

function defaultTemplate(rules: readonly PartitionRule[]): string {
  return rules.map((rule) => `{${rule.name}}`).join('/');
}

function applyTemplate(template: string, segments: Map<string, string>): string {
  return template.replace(/\{([^{}]+)\}/g, (raw, name: string) => {
    const segment = segments.get(name);
    return segment === undefined ? raw : segment;
  });
}

export function projectPaths(
  rules: readonly PartitionRule[],
  predicates: Predicates = {},
  options: ProjectOptions = {},
): Projection {
  const template = options.template ?? defaultTemplate(rules);
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
  const columns: { rule: PartitionRule; values: (string | number)[] }[] = [];
  for (const rule of rules) {
    const values = columnDomain(rule, predicates[rule.name]);
    if (values === null) {
      return {
        closed: false,
        paths: [],
        reason: `column "${rule.name}" is injected and requires an eq/in predicate`,
      };
    }
    columns.push({ rule, values });
  }
  let total = 1;
  for (const column of columns) total *= column.values.length;
  if (total === 0) return { closed: true, paths: [] };
  if (total > maxPaths) {
    return {
      closed: false,
      paths: [],
      reason: `projection of ${total} paths exceeds budget ${maxPaths}`,
    };
  }
  const paths: string[] = [];
  const segments = new Map<string, string>();
  const walk = (index: number): void => {
    if (index === columns.length) {
      paths.push(applyTemplate(template, segments));
      return;
    }
    const { rule, values } = columns[index];
    for (const value of values) {
      segments.set(rule.name, segmentFor(rule, value));
      walk(index + 1);
    }
  };
  walk(0);
  return { closed: true, paths };
}

function valueFromSegment(rule: PartitionRule, segment: string): string | number | null {
  switch (rule.type) {
    case 'integer': {
      if (!/^-?\d+$/.test(segment)) return null;
      const value = Number(segment);
      const [lo, hi] = rule.range;
      return value >= lo && value <= hi ? value : null;
    }
    case 'date': {
      const ms = parseDateSegment(rule, segment);
      return ms === null ? null : new Date(ms).toISOString();
    }
    case 'enum':
      return rule.values.includes(segment) ? segment : null;
    case 'injected':
      return segment;
  }
}

export function parsePath(
  rules: readonly PartitionRule[],
  path: string,
  template?: string,
): PartitionValues | null {
  const byName = new Map(rules.map((rule) => [rule.name, rule]));
  const order: PartitionRule[] = [];
  const source = escapeRegExp(template ?? defaultTemplate(rules)).replace(
    /\\\{([^{}]+)\\\}/g,
    (raw, name: string) => {
      const rule = byName.get(name);
      if (!rule) return raw;
      order.push(rule);
      return '([^/]+)';
    },
  );
  const match = new RegExp(`^${source}$`).exec(path);
  if (!match || order.length !== rules.length) return null;
  const values: PartitionValues = {};
  for (let i = 0; i < order.length; i += 1) {
    const value = valueFromSegment(order[i], match[i + 1]);
    if (value === null) return null;
    values[order[i].name] = value;
  }
  return values;
}
