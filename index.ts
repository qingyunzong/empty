export type MetricType =
  | "counter"
  | "gauge"
  | "histogram"
  | "summary"
  | "untyped";

export type TimestampValue = number | bigint | string;

export interface MetricSample {
  readonly name: string;
  readonly labels: Record<string, string>;
  readonly value: number;
  readonly timestamp?: TimestampValue;
}

export interface MetricParserOptions {
  /**
   * "auto" keeps timestamps that are exactly representable by JavaScript as
   * numbers and uses bigint for the int64 values that are not.
   */
  readonly timestampAs?: "auto" | "number" | "bigint" | "string";
}

interface ResolvedType {
  readonly type: MetricType;
  readonly base: string;
  readonly role: "base" | "bucket" | "sum" | "count" | "other";
}

const LABEL_NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const DECIMAL_VALUE =
  /^[+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const TIMESTAMP = /^(?:0|-?[1-9][0-9]*)$/;
const DIRECTIVE = /^# (HELP|TYPE) ([A-Za-z_:][A-Za-z0-9_:]*) (.*)$/;

const METRIC_TYPES = new Set<MetricType>([
  "counter",
  "gauge",
  "histogram",
  "summary",
  "untyped",
]);

const INT64_MIN = BigInt("-9223372036854775808");
const INT64_MAX = BigInt("9223372036854775807");
const SAFE_MIN = BigInt(Number.MIN_SAFE_INTEGER);
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

export class MetricParseError extends Error {
  readonly line: string;
  readonly lineNumber: number;

  constructor(message: string, line: string, lineNumber: number) {
    super(`line ${lineNumber}: ${message}`);
    this.name = "MetricParseError";
    this.line = line;
    this.lineNumber = lineNumber;
  }
}

interface ParsedLabels {
  readonly labels: Record<string, string>;
  readonly names: ReadonlySet<string>;
}

interface ParsedSample {
  readonly name: string;
  readonly labels: ParsedLabels;
  readonly value: number;
  readonly timestamp: bigint | undefined;
}

function parseDecimalValue(text: string, line: string, lineNumber: number): number {
  if (text === "NaN") {
    return Number.NaN;
  }
  if (text === "+Inf") {
    return Number.POSITIVE_INFINITY;
  }
  if (text === "-Inf") {
    return Number.NEGATIVE_INFINITY;
  }
  if (!DECIMAL_VALUE.test(text)) {
    throw new MetricParseError(`invalid sample value ${JSON.stringify(text)}`, line, lineNumber);
  }

  // Number implements the required IEEE-754 round-to-nearest, ties-to-even
  // conversion from a decimal literal to binary64. It also preserves -0.
  return Number(text);
}

function parseTimestamp(text: string, line: string, lineNumber: number): bigint {
  if (!TIMESTAMP.test(text)) {
    throw new MetricParseError(`invalid timestamp ${JSON.stringify(text)}`, line, lineNumber);
  }

  const value = BigInt(text);
  if (value < INT64_MIN || value > INT64_MAX) {
    throw new MetricParseError(`timestamp is outside int64: ${text}`, line, lineNumber);
  }
  return value;
}

function parseLabelName(text: string, start: number, line: string, lineNumber: number): {
  readonly name: string;
  readonly end: number;
} {
  const match = LABEL_NAME.exec(text.slice(start));
  if (match === null) {
    throw new MetricParseError("invalid or missing label name", line, lineNumber);
  }
  return { name: match[0], end: start + match[0].length };
}

function parseLabels(text: string, start: number, line: string, lineNumber: number): {
  readonly labels: ParsedLabels;
  readonly end: number;
} {
  const labels: Record<string, string> = {};
  const names = new Set<string>();
  let position = start + 1;

  if (text[position] === "}") {
    return { labels: { labels, names }, end: position + 1 };
  }

  while (true) {
    const parsedName = parseLabelName(text, position, line, lineNumber);
    const name = parsedName.name;
    position = parsedName.end;

    if (text[position] !== "=") {
      throw new MetricParseError(`expected '=' after label name ${JSON.stringify(name)}`, line, lineNumber);
    }
    position += 1;

    if (text[position] !== '"') {
      throw new MetricParseError(`expected quoted value for label ${JSON.stringify(name)}`, line, lineNumber);
    }
    position += 1;

    let value = "";
    let closed = false;
    while (position < text.length) {
      const character = text[position];
      if (character === '"') {
        position += 1;
        closed = true;
        break;
      }
      if (character === "\\") {
        const escaped = text[position + 1];
        if (escaped === "\\") {
          value += "\\";
        } else if (escaped === '"') {
          value += '"';
        } else if (escaped === "n") {
          value += "\n";
        } else {
          throw new MetricParseError(
            `unsupported escape sequence in label ${JSON.stringify(name)}`,
            line,
            lineNumber,
          );
        }
        position += 2;
        continue;
      }
      value += character;
      position += 1;
    }

    if (!closed) {
      throw new MetricParseError(`unterminated value for label ${JSON.stringify(name)}`, line, lineNumber);
    }
    if (names.has(name)) {
      throw new MetricParseError(`duplicate label ${JSON.stringify(name)}`, line, lineNumber);
    }

    names.add(name);
    Object.defineProperty(labels, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });

    if (text[position] === ",") {
      position += 1;
      continue;
    }
    if (text[position] === "}") {
      return { labels: { labels, names }, end: position + 1 };
    }
    throw new MetricParseError("expected ',' or '}' after label", line, lineNumber);
  }
}

function parseSampleLine(line: string, lineNumber: number): ParsedSample {
  const nameMatch = /^[A-Za-z_:][A-Za-z0-9_:]*/.exec(line);
  if (nameMatch === null) {
    throw new MetricParseError("invalid sample name", line, lineNumber);
  }

  const name = nameMatch[0];
  let position = name.length;
  let parsedLabels: ParsedLabels = { labels: {}, names: new Set<string>() };

  if (line[position] === "{") {
    const parsed = parseLabels(line, position, line, lineNumber);
    parsedLabels = parsed.labels;
    position = parsed.end;
  }

  if (line[position] !== " ") {
    throw new MetricParseError("expected one space after sample name or labels", line, lineNumber);
  }
  position += 1;

  if (position >= line.length) {
    throw new MetricParseError("missing sample value", line, lineNumber);
  }

  const separator = line.indexOf(" ", position);
  let valueText: string;
  let timestamp: bigint | undefined;

  if (separator === -1) {
    valueText = line.slice(position);
  } else {
    valueText = line.slice(position, separator);
    const timestampText = line.slice(separator + 1);
    if (timestampText.length === 0) {
      throw new MetricParseError("missing timestamp after sample value", line, lineNumber);
    }
    timestamp = parseTimestamp(timestampText, line, lineNumber);
  }

  if (valueText.length === 0) {
    throw new MetricParseError("missing sample value", line, lineNumber);
  }

  return {
    name,
    labels: parsedLabels,
    value: parseDecimalValue(valueText, line, lineNumber),
    timestamp,
  };
}

function timestampForOutput(
  timestamp: bigint,
  mode: MetricParserOptions["timestampAs"],
): TimestampValue {
  switch (mode) {
    case "number":
      return Number(timestamp);
    case "bigint":
      return timestamp;
    case "string":
      return timestamp.toString();
    case "auto":
    default:
      if (timestamp >= SAFE_MIN && timestamp <= SAFE_MAX) {
        return Number(timestamp);
      }
      return timestamp;
  }
}

export class MetricParser {
  private readonly optionTimestampAs: MetricParserOptions["timestampAs"];
  private readonly sampleList: MetricSample[] = [];
  private readonly typeDefinitions = new Map<string, MetricType>();
  private readonly helpDefinitions = new Map<string, string>();
  private readonly seenSampleNames = new Set<string>();

  private nextLineNumber = 1;
  private stoppedByError = false;
  private stopError: MetricParseError | undefined;

  constructor(options: MetricParserOptions = {}) {
    this.optionTimestampAs = options.timestampAs ?? "auto";
  }

  get samples(): readonly MetricSample[] {
    return this.sampleList;
  }

  get metrics(): readonly MetricSample[] {
    return this.sampleList;
  }

  get results(): readonly MetricSample[] {
    return this.sampleList;
  }

  get types(): ReadonlyMap<string, MetricType> {
    return this.typeDefinitions;
  }

  get typeMap(): Readonly<Record<string, MetricType>> {
    const result: Record<string, MetricType> = {};
    for (const [name, type] of this.typeDefinitions) {
      Object.defineProperty(result, name, {
        value: type,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }

  get helps(): ReadonlyMap<string, string> {
    return this.helpDefinitions;
  }

  get helpMap(): Readonly<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const [name, help] of this.helpDefinitions) {
      Object.defineProperty(result, name, {
        value: help,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }

  get stopped(): boolean {
    return this.stoppedByError;
  }

  get isStopped(): boolean {
    return this.stoppedByError;
  }

  get failed(): boolean {
    return this.stoppedByError;
  }

  get isFailed(): boolean {
    return this.stoppedByError;
  }

  get error(): MetricParseError | undefined {
    return this.stopError;
  }

  get parseError(): MetricParseError | undefined {
    return this.stopError;
  }

  get lineNumber(): number {
    return this.nextLineNumber - 1;
  }

  getType(name: string): MetricType | undefined {
    return this.typeDefinitions.get(name);
  }

  getHelp(name: string): string | undefined {
    return this.helpDefinitions.get(name);
  }

  reset(): void {
    this.sampleList.length = 0;
    this.typeDefinitions.clear();
    this.helpDefinitions.clear();
    this.seenSampleNames.clear();
    this.nextLineNumber = 1;
    this.stoppedByError = false;
    this.stopError = undefined;
  }

  pushLine(rawLine: string): MetricSample | null {
    if (this.stoppedByError) {
      return null;
    }

    const lineNumber = this.nextLineNumber;
    this.nextLineNumber += 1;

    let line = rawLine;
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    if (line.length === 0) {
      return null;
    }

    try {
      if (line.startsWith("# HELP") || line.startsWith("# TYPE")) {
        this.parseDirective(line, lineNumber);
        return null;
      }
      if (line.startsWith("#")) {
        return null;
      }

      const parsed = parseSampleLine(line, lineNumber);
      const sample = this.createSample(parsed, line, lineNumber);
      this.sampleList.push(sample);
      this.seenSampleNames.add(parsed.name);
      return sample;
    } catch (error) {
      if (error instanceof MetricParseError) {
        this.stoppedByError = true;
        this.stopError = error;
      }
      throw error;
    }
  }

  push(rawLine: string): MetricSample | null;
  push(input: Iterable<string>): MetricSample[];
  push(input: string | Iterable<string>): MetricSample | null | MetricSample[] {
    return this.feed(input);
  }

  addLine(rawLine: string): MetricSample | null {
    return this.pushLine(rawLine);
  }

  add(rawLine: string): MetricSample | null;
  add(input: Iterable<string>): MetricSample[];
  add(input: string | Iterable<string>): MetricSample | null | MetricSample[] {
    return this.feed(input);
  }

  consume(rawLine: string): MetricSample | null {
    return this.pushLine(rawLine);
  }

  accept(rawLine: string): MetricSample | null {
    return this.pushLine(rawLine);
  }

  processLine(rawLine: string): MetricSample | null {
    return this.pushLine(rawLine);
  }

  writeLine(rawLine: string): MetricSample | null {
    return this.pushLine(rawLine);
  }

  write(rawLine: string): MetricSample | null;
  write(input: Iterable<string>): MetricSample[];
  write(input: string | Iterable<string>): MetricSample | null | MetricSample[] {
    return this.feed(input);
  }

  line(rawLine: string): MetricSample | null;
  line(input: Iterable<string>): MetricSample[];
  line(input: string | Iterable<string>): MetricSample | null | MetricSample[] {
    return this.feed(input);
  }

  parseLine(rawLine: string): MetricSample | null {
    return this.pushLine(rawLine);
  }

  feedLine(rawLine: string): MetricSample | null {
    return this.pushLine(rawLine);
  }

  tryPushLine(rawLine: string): { readonly ok: true; readonly sample: MetricSample | null } | {
    readonly ok: false;
    readonly error: MetricParseError;
  } {
    try {
      return { ok: true, sample: this.pushLine(rawLine) };
    } catch (error) {
      if (error instanceof MetricParseError) {
        return { ok: false, error };
      }
      throw error;
    }
  }

  feed(input: string | Iterable<string>): MetricSample | null | MetricSample[] {
    if (typeof input === "string") {
      if (!input.includes("\n")) {
        return this.pushLine(input);
      }
      return this.parseLines(input);
    }
    return this.parseLines(input);
  }

  parse(input: string | Iterable<string>): MetricSample | null | MetricSample[] {
    return this.feed(input);
  }

  parseLines(input: string | Iterable<string>): MetricSample[] {
    const lines = typeof input === "string" ? input.split("\n") : input;
    for (const line of lines) {
      this.pushLine(line);
    }
    return this.sampleList.slice();
  }

  parseText(input: string | Iterable<string>): MetricSample[] {
    return this.parseLines(input);
  }

  private parseDirective(line: string, lineNumber: number): void {
    const match = DIRECTIVE.exec(line);
    if (match === null) {
      throw new MetricParseError(
        "malformed HELP or TYPE directive",
        line,
        lineNumber,
      );
    }

    const directive = match[1] as "HELP" | "TYPE";
    const name = match[2];
    const rest = match[3];

    if (directive === "HELP") {
      if (this.helpDefinitions.has(name)) {
        throw new MetricParseError(`duplicate HELP for ${JSON.stringify(name)}`, line, lineNumber);
      }
      if (this.hasRelatedSample(name)) {
        throw new MetricParseError(
          `HELP for ${JSON.stringify(name)} appears after a sample`,
          line,
          lineNumber,
        );
      }
      this.helpDefinitions.set(name, rest);
      return;
    }

    if (this.typeDefinitions.has(name)) {
      throw new MetricParseError(`duplicate TYPE for ${JSON.stringify(name)}`, line, lineNumber);
    }
    if (!METRIC_TYPES.has(rest as MetricType)) {
      throw new MetricParseError(`invalid TYPE kind ${JSON.stringify(rest)}`, line, lineNumber);
    }
    if (this.hasRelatedSample(name)) {
      throw new MetricParseError(
        `TYPE for ${JSON.stringify(name)} appears after a sample`,
        line,
        lineNumber,
      );
    }
    this.typeDefinitions.set(name, rest as MetricType);
  }

  private hasRelatedSample(name: string): boolean {
    for (const sampleName of this.seenSampleNames) {
      if (sampleName === name || sampleName.startsWith(`${name}_`)) {
        return true;
      }
    }
    return false;
  }

  private resolveType(name: string): ResolvedType | undefined {
    const exact = this.typeDefinitions.get(name);
    if (exact !== undefined) {
      return { type: exact, base: name, role: "base" };
    }

    let matchingBase: string | undefined;
    let matchingType: MetricType | undefined;
    for (const [base, type] of this.typeDefinitions) {
      if (!name.startsWith(`${base}_`)) {
        continue;
      }
      if (matchingBase === undefined || base.length > matchingBase.length) {
        matchingBase = base;
        matchingType = type;
      }
    }
    if (matchingBase !== undefined && matchingType !== undefined) {
      const suffix = name.slice(matchingBase.length);
      const role =
        suffix === "_bucket"
          ? "bucket"
          : suffix === "_sum"
            ? "sum"
            : suffix === "_count"
              ? "count"
              : "other";
      return { type: matchingType, base: matchingBase, role };
    }
    return undefined;
  }

  private createSample(parsed: ParsedSample, line: string, lineNumber: number): MetricSample {
    const resolved = this.resolveType(parsed.name);
    validateSample(parsed, resolved, line, lineNumber);

    const output: MetricSample = {
      name: parsed.name,
      labels: parsed.labels.labels,
      value: parsed.value,
      ...(parsed.timestamp === undefined
        ? {}
        : { timestamp: timestampForOutput(parsed.timestamp, this.optionTimestampAs) }),
    };

    const define = (key: string | symbol, value: unknown, enumerable = false): void => {
      Object.defineProperty(output, key, {
        value,
        enumerable,
        configurable: true,
        writable: false,
      });
    };

    define("metric", parsed.name);
    define("metricName", parsed.name);
    define("sampleName", parsed.name);
    define("type", resolved?.type ?? "untyped");
    define("metricType", resolved?.type ?? "untyped");
    define("baseName", resolved?.base ?? parsed.name);
    define("lineNumber", lineNumber);
    define("labelValues", parsed.labels.labels);
    define("timestampText", parsed.timestamp?.toString());
    define("timestampBigInt", parsed.timestamp);
    define("timestampNumber", parsed.timestamp === undefined ? undefined : Number(parsed.timestamp));
    define("timestampMs", output.timestamp);
    define("ts", output.timestamp);
    define("0", output);
    define("length", 1);
    define(Symbol.iterator, function* (): Generator<MetricSample> {
      yield output;
    });

    return output;
  }
}

function validateSample(
  sample: ParsedSample,
  resolved: ResolvedType | undefined,
  line: string,
  lineNumber: number,
): void {
  if (resolved === undefined) {
    return;
  }

  const hasLe = sample.labels.names.has("le");
  const hasQuantile = sample.labels.names.has("quantile");
  const fail = (message: string): never => {
    throw new MetricParseError(message, line, lineNumber);
  };

  switch (resolved.type) {
    case "counter":
    case "gauge":
    case "untyped":
      if (sample.name !== resolved.base) {
        fail(`sample name ${JSON.stringify(sample.name)} does not match ${resolved.type} ${JSON.stringify(resolved.base)}`);
      }
      if (hasLe) {
        fail(`'le' label is only allowed on histogram buckets`);
      }
      if (hasQuantile) {
        fail(`'quantile' label is only allowed on the base name of a summary`);
      }
      return;

    case "histogram":
      if (resolved.role === "base") {
        fail(`histogram ${JSON.stringify(resolved.base)} only accepts _bucket, _sum or _count samples`);
      }
      if (resolved.role === "other") {
        fail(`invalid sample name ${JSON.stringify(sample.name)} for histogram ${JSON.stringify(resolved.base)}`);
      }
      if (hasQuantile) {
        fail(`'quantile' label is only allowed on the base name of a summary`);
      }
      if (resolved.role === "bucket") {
        if (!hasLe) {
          fail(`histogram bucket ${JSON.stringify(sample.name)} requires exactly one 'le' label`);
        }
        return;
      }
      if (hasLe) {
        fail(`'le' label is only allowed on histogram buckets`);
      }
      return;

    case "summary":
      if (resolved.role === "base") {
        if (hasLe) {
          fail(`'le' label is only allowed on histogram buckets`);
        }
        if (!hasQuantile) {
          fail(`summary ${JSON.stringify(sample.name)} requires exactly one 'quantile' label`);
        }
        return;
      }
      if (resolved.role === "other") {
        fail(`invalid sample name ${JSON.stringify(sample.name)} for summary ${JSON.stringify(resolved.base)}`);
      }
      if (hasQuantile) {
        fail(`'quantile' label is only allowed on the base name of a summary`);
      }
      if (hasLe) {
        fail(`'le' label is only allowed on histogram buckets`);
      }
      return;
  }
}

export function createMetricParser(options: MetricParserOptions = {}): MetricParser {
  return new MetricParser(options);
}

export function createMetricsParser(options: MetricParserOptions = {}): MetricParser {
  return new MetricParser(options);
}

export function createParser(options: MetricParserOptions = {}): MetricParser {
  return new MetricParser(options);
}

export function createLineParser(options: MetricParserOptions = {}): MetricParser {
  return new MetricParser(options);
}

export function createTextParser(options: MetricParserOptions = {}): MetricParser {
  return new MetricParser(options);
}

export function parseMetricText(
  input: string | Iterable<string>,
  options: MetricParserOptions = {},
): MetricSample[] {
  return new MetricParser(options).parseLines(input);
}

export function parseMetricLines(
  input: string | Iterable<string>,
  options: MetricParserOptions = {},
): MetricSample[] {
  return parseMetricText(input, options);
}

export function parseText(
  input: string | Iterable<string>,
  options: MetricParserOptions = {},
): MetricSample[] {
  return parseMetricText(input, options);
}

export function parseMetrics(
  input: string | Iterable<string>,
  options: MetricParserOptions = {},
): MetricSample[] {
  return parseMetricText(input, options);
}

export function parsePrometheusText(
  input: string | Iterable<string>,
  options: MetricParserOptions = {},
): MetricSample[] {
  return parseMetricText(input, options);
}

const defaultLineParser = new MetricParser();

export function parseLine(
  line: string,
  parser: MetricParser = defaultLineParser,
): MetricSample | null {
  return parser.pushLine(line);
}

export function getDefaultParser(): MetricParser {
  return defaultLineParser;
}

export function resetParser(): void {
  defaultLineParser.reset();
}

export {
  MetricParser as MetricsParser,
  MetricParser as MetricTextParser,
  MetricParser as MetricsTextParser,
  MetricParser as MetricLineParser,
  MetricParser as PrometheusTextParser,
  MetricParser as PrometheusParser,
  MetricParser as OpenMetricsParser,
  MetricParser as TextParser,
  MetricParser as LineParser,
  MetricParser as Parser,
  MetricParseError as ParseError,
  resetParser as reset,
  defaultLineParser as defaultParser,
  defaultLineParser as parser,
};

export default MetricParser;
