/**
 * Deterministic, locale-independent collation over Unicode scalar sequences.
 *
 * The host supplies Unicode scalars that have already been normalized.  This
 * module deliberately does not normalise text and does not consult the host
 * locale (there is no Intl.Collator and no locale-sensitive comparison here).
 *
 * A rule maps a non-empty scalar sequence to zero or more collation elements
 * (CEs).  Rules are matched with the longest-complete-rule rule.  If no rule
 * matches at a scalar position, one scalar is consumed and a fallback CE is
 * generated.
 */

export const MAX_RULE_PRIMARY = 0x1fffff;
export const MAX_SECONDARY = 0xffff;
export const MAX_TERTIARY = 0xffff;
export const FALLBACK_PRIMARY_BASE = 0x200000;
export const SHIFTED_MARKER = 0x400000;

export type Scalar = number;
export type ScalarSequence = readonly Scalar[] | string;
export type Strength = 1 | 2 | 3 | 4;
export type VariableWeighting = "non-ignorable" | "shifted";

export interface CollationElement {
  readonly primary: number;
  readonly secondary: number;
  readonly tertiary: number;
  readonly variable: boolean;
}

/** Alias kept for callers that use the short name from the specification. */
export type CE = CollationElement;

export interface CollationRule {
  readonly source: ScalarSequence;
  readonly elements: readonly CollationElement[];
}

export type RuleTuple = readonly [
  source: ScalarSequence,
  elements: readonly CollationElement[],
];

export type RuleRecord = Readonly<Record<string, readonly CollationElement[]>>;

export type RulesInput =
  | readonly CollationRule[]
  | readonly RuleTuple[]
  | ReadonlyMap<ScalarSequence, readonly CollationElement[]>
  | RuleRecord;

export interface CollatorOptions {
  /** Rules may be supplied here, or as the first constructor argument. */
  readonly rules?: RulesInput;
  /** Defaults to non-ignorable. */
  readonly mode?: VariableWeighting;
  /** UCA spelling used by some hosts. */
  readonly alternate?: VariableWeighting;
  /** Another common spelling for alternate handling. */
  readonly variableWeighting?: VariableWeighting;
  /** Convenience flag; true selects shifted mode. */
  readonly shifted?: boolean;
  readonly backwardSecondary?: boolean;
  /** Maximum permitted scalar length of one rule.  Defaults to no limit. */
  readonly maxRuleScalars?: number;
  /** Alias for maxRuleScalars. */
  readonly maxRuleLength?: number;
  /**
   * Maximum number of CEs produced while collating a stream.  The budget is
   * charged when a rule/fallback expansion is emitted.  Defaults to no limit.
   */
  readonly maxCEs?: number;
  /** Alias for maxCEs. */
  readonly maxCECount?: number;
  /** Alias for maxCEs. */
  readonly maxCollationElements?: number;
}

export interface SourceSpan {
  /** Inclusive scalar index in the complete input sequence. */
  readonly start: number;
  /** Exclusive scalar index in the complete input sequence. */
  readonly end: number;
  /** Index of this CE within the rule's expansion (0 for fallbacks). */
  readonly expansionIndex: number;
}

/**
 * One retained weight together with its origin.  Suppressed CEs produce no
 * WeightRecord at all, so no provenance is invented for them.
 */
export interface WeightRecord {
  readonly value: number;
  readonly level: Strength;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly expansionIndex: number;
  readonly source: SourceSpan;
}

export class CollationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollationError";
  }
}

export class InvalidScalarError extends CollationError {
  constructor(value: unknown) {
    super(`Invalid Unicode scalar value: ${String(value)}`);
    this.name = "InvalidScalarError";
  }
}

export class InvalidRuleError extends CollationError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRuleError";
  }
}

export class DuplicateRuleError extends CollationError {
  constructor(source: readonly number[]) {
    super(`Duplicate rule key: [${source.join(", ")}]`);
    this.name = "DuplicateRuleError";
  }
}

export class RuleLimitExceededError extends CollationError {
  constructor(length: number, limit: number) {
    super(`Rule has ${length} scalars, exceeding limit ${limit}`);
    this.name = "RuleLimitExceededError";
  }
}

export class BudgetExceededError extends CollationError {
  constructor(limit: number) {
    super(`Collation element budget ${limit} exceeded`);
    this.name = "BudgetExceededError";
  }
}

export class CollationStateError extends CollationError {
  constructor(message: string) {
    super(message);
    this.name = "CollationStateError";
  }
}

export class NotFinishedError extends CollationStateError {
  constructor() {
    super("Key is only available after a successful Finish");
    this.name = "NotFinishedError";
  }
}

export class AlreadyFinishedError extends CollationStateError {
  constructor() {
    super("Finish has already been called");
    this.name = "AlreadyFinishedError";
  }
}

export class PushAfterFinishError extends CollationStateError {
  constructor() {
    super("Push is not allowed after Finish");
    this.name = "PushAfterFinishError";
  }
}

interface NormalizedRule {
  readonly source: readonly number[];
  readonly elements: readonly CollationElement[];
}

interface TrieTerminal {
  readonly length: number;
  readonly elements: readonly CollationElement[];
}

interface TrieNode {
  readonly children: Map<number, TrieNode>;
  terminal: TrieTerminal | null;
}

function createTrieNode(): TrieNode {
  return { children: new Map<number, TrieNode>(), terminal: null };
}

export function isUnicodeScalar(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0x10ffff &&
    !(value >= 0xd800 && value <= 0xdfff)
  );
}

function assertScalar(value: unknown): asserts value is number {
  if (!isUnicodeScalar(value)) {
    throw new InvalidScalarError(value);
  }
}

function toScalars(sequence: ScalarSequence, what: string): number[] {
  if (typeof sequence === "string") {
    const result: number[] = [];
    for (const character of sequence) {
      const scalar = character.codePointAt(0);
      if (scalar === undefined) {
        throw new InvalidScalarError(sequence);
      }
      assertScalar(scalar);
      result.push(scalar);
    }
    if (result.length === 0) {
      throw new InvalidRuleError(`${what} must not be empty`);
    }
    return result;
  }

  if (sequence == null || typeof sequence !== "object") {
    throw new InvalidRuleError(`${what} must be a scalar sequence`);
  }

  const result: number[] = [];
  for (const scalar of sequence as Iterable<unknown>) {
    assertScalar(scalar);
    result.push(scalar);
  }
  if (result.length === 0) {
    throw new InvalidRuleError(`${what} must not be empty`);
  }
  return result;
}

function normalizeElement(element: unknown, ruleLabel: string): CollationElement {
  if (element == null || typeof element !== "object") {
    throw new InvalidRuleError(`${ruleLabel}: CE must be an object`);
  }
  const candidate = element as Partial<CollationElement> & {
    p?: unknown;
    s?: unknown;
    t?: unknown;
    v?: unknown;
  };

  const primary = candidate.primary ?? candidate.p;
  const secondary = candidate.secondary ?? candidate.s;
  const tertiary = candidate.tertiary ?? candidate.t;
  const variableValue = candidate.variable ?? candidate.v;
  const variable = variableValue === undefined ? false : variableValue;

  if (
    typeof primary !== "number" ||
    !Number.isInteger(primary) ||
    primary < 0 ||
    primary > MAX_RULE_PRIMARY
  ) {
    throw new InvalidRuleError(
      `${ruleLabel}: CE primary must be an integer in 0..0x1fffff`,
    );
  }
  if (
    typeof secondary !== "number" ||
    !Number.isInteger(secondary) ||
    secondary < 0 ||
    secondary > MAX_SECONDARY
  ) {
    throw new InvalidRuleError(
      `${ruleLabel}: CE secondary must be an integer in 0..65535`,
    );
  }
  if (
    typeof tertiary !== "number" ||
    !Number.isInteger(tertiary) ||
    tertiary < 0 ||
    tertiary > MAX_TERTIARY
  ) {
    throw new InvalidRuleError(
      `${ruleLabel}: CE tertiary must be an integer in 0..65535`,
    );
  }
  if (typeof variable !== "boolean") {
    throw new InvalidRuleError(`${ruleLabel}: CE variable must be a boolean`);
  }
  if (variable && primary === 0) {
    throw new InvalidRuleError(
      `${ruleLabel}: a variable CE must have primary > 0`,
    );
  }

  return Object.freeze({ primary, secondary, tertiary, variable });
}

function normalizeExpansion(
  expansion: unknown,
  ruleLabel: string,
): readonly CollationElement[] {
  if (!Array.isArray(expansion)) {
    throw new InvalidRuleError(`${ruleLabel}: expansion must be an array`);
  }
  return Object.freeze(
    expansion.map((element, index) =>
      normalizeElement(element, `${ruleLabel} CE ${index}`),
    ),
  );
}

function isRuleObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeRulesInput(input: RulesInput | undefined): NormalizedRule[] {
  if (input == null) {
    throw new InvalidRuleError("A rules collection is required");
  }

  let entries: unknown[];
  if (input instanceof Map) {
    entries = [];
    for (const [source, expansion] of input) {
      entries.push([source, expansion]);
    }
  } else if (Array.isArray(input)) {
    entries = input;
  } else if (isRuleObject(input)) {
    entries = Object.entries(input).map(([source, expansion]) => [
      source,
      expansion,
    ]);
  } else {
    throw new InvalidRuleError("Unsupported rules collection");
  }

  const rules: NormalizedRule[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    let sourceInput: unknown;
    let expansionInput: unknown;

    if (Array.isArray(entry)) {
      if (entry.length !== 2) {
        throw new InvalidRuleError(
          "Rule tuples must contain [source, elements]",
        );
      }
      sourceInput = entry[0];
      expansionInput = entry[1];
    } else if (isRuleObject(entry)) {
      sourceInput =
        entry.source ?? entry.key ?? entry.sequence ?? entry.scalars;
      expansionInput =
        entry.elements ??
        entry.ces ??
        entry.ce ??
        entry.expansion ??
        entry.collationElements;
    } else {
      throw new InvalidRuleError(
        "Rule must be an object or a [source, elements] tuple",
      );
    }

    if (sourceInput === undefined || expansionInput === undefined) {
      throw new InvalidRuleError("Rule needs a source and an expansion");
    }

    const source = toScalars(sourceInput as ScalarSequence, "Rule source");
    const label = `[${source.join(", ")}]`;
    const key = source.join(",");
    if (seen.has(key)) {
      throw new DuplicateRuleError(source);
    }
    seen.add(key);
    const elements = normalizeExpansion(expansionInput, label);
    rules.push({ source: Object.freeze(source), elements });
  }

  return rules;
}

function readMode(options: CollatorOptions): VariableWeighting {
  const declared =
    options.mode ?? options.alternate ?? options.variableWeighting;
  let mode: VariableWeighting = declared ?? "non-ignorable";

  if (options.shifted !== undefined) {
    if (typeof options.shifted !== "boolean") {
      throw new CollationError("shifted must be a boolean");
    }
    if (options.shifted) {
      mode = "shifted";
    } else if (declared === undefined) {
      mode = "non-ignorable";
    }
  }
  if (mode !== "shifted" && mode !== "non-ignorable") {
    throw new CollationError(
      `Unknown variable weighting mode: ${String(mode)}`,
    );
  }
  return mode;
}

function readLimit(
  value: unknown,
  aliases: readonly unknown[],
  name: string,
): number {
  let limit = value;
  if (limit === undefined) {
    limit = aliases.find((candidate) => candidate !== undefined);
  }
  if (limit === undefined) return Number.POSITIVE_INFINITY;
  if (limit === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 0
  ) {
    throw new CollationError(`${name} must be a non-negative integer`);
  }
  return limit;
}

function makeWeight(
  value: number,
  level: Strength,
  start: number,
  end: number,
  expansionIndex: number,
): WeightRecord {
  const source = Object.freeze({ start, end, expansionIndex });
  return Object.freeze({
    value,
    level,
    sourceStart: start,
    sourceEnd: end,
    expansionIndex,
    source,
  });
}

/**
 * The four numeric weight streams plus provenance for every retained weight.
 *
 * `levels` contains the four arrays of numbers.  `weights` contains the same
 * weights as records carrying source spans and expansion CE indexes.
 */
export class CollationResult {
  readonly levels: readonly [number[], number[], number[], number[]];
  readonly weights: readonly [
    WeightRecord[],
    WeightRecord[],
    WeightRecord[],
    WeightRecord[],
  ];

  constructor(
    records: readonly [
      WeightRecord[],
      WeightRecord[],
      WeightRecord[],
      WeightRecord[],
    ],
  ) {
    const copy = records.map((level) => level.slice()) as unknown as [
      WeightRecord[],
      WeightRecord[],
      WeightRecord[],
      WeightRecord[],
    ];
    this.weights = Object.freeze(copy);
    this.levels = Object.freeze(
      copy.map((level) => level.map((weight) => weight.value)),
    ) as unknown as readonly [number[], number[], number[], number[]];
  }

  get streams(): readonly [number[], number[], number[], number[]] {
    return this.levels;
  }

  get provenance(): readonly [
    WeightRecord[],
    WeightRecord[],
    WeightRecord[],
    WeightRecord[],
  ] {
    return this.weights;
  }
}

export class Collator {
  readonly mode: VariableWeighting;
  readonly backwardSecondary: boolean;
  readonly maxRuleScalars: number;
  readonly maxCEs: number;

  private readonly rules: readonly NormalizedRule[];
  private readonly trie: TrieNode;
  private readonly maxRuleLength: number;
  private readonly records: [
    WeightRecord[],
    WeightRecord[],
    WeightRecord[],
    WeightRecord[],
  ] = [[], [], [], []];

  private pending: number[] = [];
  private pendingStart = 0;
  private generatedCEs = 0;
  private suppressed = false;
  private finished = false;
  private failed = false;
  private finishedResult: CollationResult | null = null;

  constructor(rules: RulesInput, options?: CollatorOptions);
  constructor(options: CollatorOptions & { rules: RulesInput });
  constructor(
    rulesOrOptions: RulesInput | (CollatorOptions & { rules: RulesInput }),
    maybeOptions: CollatorOptions = {},
  ) {
    let rulesInput: RulesInput | undefined;
    let options: CollatorOptions;

    if (isRuleObject(rulesOrOptions) && "rules" in rulesOrOptions) {
      const candidate = rulesOrOptions as unknown as CollatorOptions & {
        rules: RulesInput;
      };
      rulesInput = candidate.rules;
      options = { ...candidate, ...maybeOptions };
    } else {
      rulesInput = rulesOrOptions as RulesInput;
      options = { ...maybeOptions };
    }

    this.mode = readMode(options);
    this.backwardSecondary =
      options.backwardSecondary === undefined
        ? false
        : options.backwardSecondary;
    if (typeof this.backwardSecondary !== "boolean") {
      throw new CollationError("backwardSecondary must be a boolean");
    }

    this.maxRuleScalars = readLimit(
      options.maxRuleScalars,
      [options.maxRuleLength],
      "maxRuleScalars",
    );
    this.maxCEs = readLimit(
      options.maxCEs,
      [options.maxCECount, options.maxCollationElements],
      "maxCEs",
    );

    const rules = normalizeRulesInput(rulesInput);
    const trie = createTrieNode();
    let maxRuleLength = 0;

    for (const rule of rules) {
      if (rule.source.length > this.maxRuleScalars) {
        throw new RuleLimitExceededError(
          rule.source.length,
          this.maxRuleScalars,
        );
      }
      maxRuleLength = Math.max(maxRuleLength, rule.source.length);

      let node = trie;
      for (const scalar of rule.source) {
        let child = node.children.get(scalar);
        if (child === undefined) {
          child = createTrieNode();
          node.children.set(scalar, child);
        }
        node = child;
      }
      if (node.terminal !== null) {
        throw new DuplicateRuleError(rule.source);
      }
      node.terminal = Object.freeze({
        length: rule.source.length,
        elements: rule.elements,
      });
    }

    this.rules = Object.freeze(rules);
    this.trie = trie;
    this.maxRuleLength = maxRuleLength;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** Number of not-yet-determined scalars retained as the rule frontier. */
  get pendingScalarCount(): number {
    return this.pending.length;
  }

  get generatedCECount(): number {
    return this.generatedCEs;
  }

  /** A copy of the normalized rule set, useful for independent comparisons. */
  getRules(): readonly CollationRule[] {
    return this.rules.map((rule) =>
      Object.freeze({
        source: Object.freeze(rule.source.slice()),
        elements: rule.elements,
      }),
    );
  }

  push(chunk: ScalarSequence): this {
    if (this.finished) {
      throw new PushAfterFinishError();
    }
    if (this.failed) {
      throw new CollationStateError("Collator is in a failed state");
    }

    const scalars = coerceSequence(chunk, "Push chunk");
    for (const scalar of scalars) {
      this.pending.push(scalar);

      // A scalar at the front is safe to commit only after the full maximum
      // rule width is available.  This is what prevents a short rule at a
      // chunk boundary from being delivered before a longer rule could match.
      // Processing after each appended scalar keeps the retained frontier
      // bounded even when a caller supplies a very large chunk.
      while (
        this.pending.length > 0 &&
        this.pending.length >= this.maxRuleLength
      ) {
        this.processFront();
      }
    }
    return this;
  }

  finish(): CollationResult {
    if (this.finished) {
      throw new AlreadyFinishedError();
    }
    if (this.failed) {
      throw new CollationStateError("Collator is in a failed state");
    }

    try {
      while (this.pending.length > 0) {
        this.processFront();
      }
      if (this.backwardSecondary) {
        this.records[1].reverse();
      }
      this.finishedResult = new CollationResult(this.records);
      this.finished = true;
      return this.finishedResult;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  /** Specification spelling. */
  Push(chunk: ScalarSequence): this {
    return this.push(chunk);
  }

  /** Specification spelling. */
  Finish(): CollationResult {
    return this.finish();
  }

  private processFront(): void {
    const match = this.matchLongest();
    const start = this.pendingStart;
    const length = match === null ? 1 : match.length;
    const end = start + length;
    const expansion: readonly CollationElement[] =
      match === null
        ? Object.freeze([
            Object.freeze({
              primary: FALLBACK_PRIMARY_BASE + this.pending[0],
              secondary: 0,
              tertiary: 0,
              variable: false,
            }),
          ])
        : match.elements;

    if (this.generatedCEs + expansion.length > this.maxCEs) {
      throw new BudgetExceededError(this.maxCEs);
    }

    // Commit the source prefix only after the expansion passed its budget
    // check.  The consumed scalars are never retained or scanned again.
    this.pending.splice(0, length);
    this.pendingStart = end;
    this.generatedCEs += expansion.length;

    for (let index = 0; index < expansion.length; index += 1) {
      this.emitElement(expansion[index], start, end, index);
    }
  }

  private matchLongest(): TrieTerminal | null {
    let node = this.trie;
    let longest: TrieTerminal | null = null;
    const available = this.pending.length;

    for (let index = 0; index < available; index += 1) {
      const child = node.children.get(this.pending[index]);
      if (child === undefined) break;
      node = child;
      if (node.terminal !== null) {
        longest = node.terminal;
      }
    }
    return longest;
  }

  private emitElement(
    element: CollationElement,
    start: number,
    end: number,
    expansionIndex: number,
  ): void {
    if (this.mode === "non-ignorable") {
      this.addNormalWeights(element, start, end, expansionIndex);
      return;
    }

    // Shifted mode.
    if (element.variable) {
      // Variable CEs contribute only their own primary, at the fourth level,
      // and keep suppression active.
      this.addWeight(4, element.primary, start, end, expansionIndex);
      this.suppressed = true;
      return;
    }

    if (this.suppressed) {
      if (element.primary === 0) {
        // The whole CE is ignored, including its secondary and tertiary.
        return;
      }
      this.suppressed = false;
      this.addNormalWeights(element, start, end, expansionIndex);
      this.addWeight(4, SHIFTED_MARKER, start, end, expansionIndex);
      return;
    }

    this.addNormalWeights(element, start, end, expansionIndex);
  }

  private addNormalWeights(
    element: CollationElement,
    start: number,
    end: number,
    expansionIndex: number,
  ): void {
    if (element.primary !== 0) {
      this.addWeight(1, element.primary, start, end, expansionIndex);
    }
    if (element.secondary !== 0) {
      this.addWeight(2, element.secondary, start, end, expansionIndex);
    }
    if (element.tertiary !== 0) {
      this.addWeight(3, element.tertiary, start, end, expansionIndex);
    }
  }

  private addWeight(
    level: Strength,
    value: number,
    start: number,
    end: number,
    expansionIndex: number,
  ): void {
    this.records[level - 1].push(
      makeWeight(value, level, start, end, expansionIndex),
    );
  }

  /**
   * Returns the key for the first `strength` levels.  Each nonzero weight is
   * written as four unsigned big-endian bytes and each level ends with four
   * zero bytes.  Zero weights are never written as weights.
   */
  key(strength: Strength = 4): Uint8Array {
    if (!this.finished || this.finishedResult === null) {
      throw new NotFinishedError();
    }
    validateStrength(strength);
    return encodeWeights(this.finishedResult.levels, strength);
  }

  /** Specification spelling. */
  Key(strength: Strength = 4): Uint8Array {
    return this.key(strength);
  }

  getKey(strength: Strength = 4): Uint8Array {
    return this.key(strength);
  }

  get result(): CollationResult | null {
    return this.finishedResult;
  }

  /**
   * Collates a complete scalar sequence with this collator's rules.  The
   * incremental state of `this` is not touched.
   */
  collate(sequence: ScalarSequence): CollationResult {
    const fresh = this.freshCollator();
    fresh.push(sequence);
    return fresh.finish();
  }

  /** Key of a complete scalar sequence using this collator's configuration. */
  keyFor(sequence: ScalarSequence, strength: Strength = 4): Uint8Array {
    const fresh = this.freshCollator();
    fresh.push(sequence);
    fresh.finish();
    return fresh.key(strength);
  }

  /**
   * Compares two complete scalar sequences at the requested strength.
   * Returns a negative, zero, or positive number.  A zero result at a lower
   * strength is final; no text or suppressed level is used as a tie breaker.
   */
  compare(
    a: ScalarSequence,
    b: ScalarSequence,
    strength: Strength = 4,
  ): number {
    validateStrength(strength);
    const left = this.collate(a);
    const right = this.collate(b);
    return compareLevels(left.levels, right.levels, strength);
  }

  private freshCollator(): Collator {
    return new Collator(this.getRules(), {
      mode: this.mode,
      backwardSecondary: this.backwardSecondary,
      maxRuleScalars: this.maxRuleScalars,
      maxCEs: this.maxCEs,
    });
  }
}

function coerceSequence(sequence: ScalarSequence, what: string): number[] {
  if (sequence == null) {
    throw new InvalidRuleError(`${what} must be a scalar sequence`);
  }
  if (typeof sequence === "string") {
    const result: number[] = [];
    for (const character of sequence) {
      const scalar = character.codePointAt(0);
      if (scalar === undefined) {
        throw new InvalidScalarError(sequence);
      }
      assertScalar(scalar);
      result.push(scalar);
    }
    return result;
  }
  if (typeof sequence !== "object") {
    throw new InvalidRuleError(`${what} must be a scalar sequence`);
  }
  const result: number[] = [];
  for (const scalar of sequence as Iterable<unknown>) {
    assertScalar(scalar);
    result.push(scalar);
  }
  return result;
}

function validateStrength(strength: unknown): asserts strength is Strength {
  if (
    typeof strength !== "number" ||
    !Number.isInteger(strength) ||
    strength < 1 ||
    strength > 4
  ) {
    throw new CollationError("strength must be an integer in 1..4");
  }
}

export function compareLevels(
  left: readonly number[][],
  right: readonly number[][],
  strength: Strength = 4,
): number {
  validateStrength(strength);
  for (let level = 0; level < strength; level += 1) {
    const a = left[level];
    const b = right[level];
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      if (a[index] !== b[index]) {
        return a[index] < b[index] ? -1 : 1;
      }
    }
    if (a.length !== b.length) {
      return a.length < b.length ? -1 : 1;
    }
  }
  return 0;
}

export function encodeWeights(
  levels: readonly number[][],
  strength: Strength = 4,
): Uint8Array {
  validateStrength(strength);
  let weightCount = 0;
  for (let level = 0; level < strength; level += 1) {
    weightCount += levels[level].length;
  }
  const bytes = new Uint8Array(weightCount * 4 + strength * 4);
  let offset = 0;
  for (let level = 0; level < strength; level += 1) {
    for (const value of levels[level]) {
      bytes[offset] = (value >>> 24) & 0xff;
      bytes[offset + 1] = (value >>> 16) & 0xff;
      bytes[offset + 2] = (value >>> 8) & 0xff;
      bytes[offset + 3] = value & 0xff;
      offset += 4;
    }
    // The terminator's four zero bytes were zero-initialised already.
    offset += 4;
  }
  return bytes;
}

/** Unsigned bytewise lexicographic comparison of key byte strings. */
export function compareKeyBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/** Accepts a complete rule object, or a Collator to reuse its configuration. */
export type CompareOptions =
  | (CollatorOptions & { rules: RulesInput })
  | Collator
  | RulesInput;

function collatorForOptions(options: CompareOptions): Collator {
  if (options instanceof Collator) return options;
  return new Collator(options as RulesInput);
}

export function compareSequences(
  a: ScalarSequence,
  b: ScalarSequence,
  options: CompareOptions,
  strength: Strength = 4,
): number {
  const collator = collatorForOptions(options);
  return collator.compare(a, b, strength);
}

/** Capitalised spelling requested by the specification. */
export const Compare = compareSequences;

export function keyForSequence(
  sequence: ScalarSequence,
  options: CompareOptions,
  strength: Strength = 4,
): Uint8Array {
  const collator = collatorForOptions(options);
  return collator.keyFor(sequence, strength);
}

export function compareKeys(
  a: ScalarSequence,
  b: ScalarSequence,
  options: CompareOptions,
  strength: Strength = 4,
): number {
  return compareKeyBytes(
    keyForSequence(a, options, strength),
    keyForSequence(b, options, strength),
  );
}

/**
 * Stable collation sort.  Items with equal keys retain their original
 * position; no source text is consulted as a tie breaker.
 */
export function stableSortByCollation<T>(
  items: readonly T[],
  getSequence: (item: T) => ScalarSequence,
  options: CompareOptions,
  strength: Strength = 4,
): T[] {
  const collator = collatorForOptions(options);
  const decorated = items.map((item, index) => ({
    item,
    index,
    key: collator.keyFor(getSequence(item), strength),
  }));

  decorated.sort((left, right) => {
    const comparison = compareKeyBytes(left.key, right.key);
    return comparison !== 0 ? comparison : left.index - right.index;
  });
  return decorated.map((entry) => entry.item);
}

/** Alias with a shorter name for host code. */
export const stableSort = stableSortByCollation;

/** Creates a comparator over complete scalar sequences. */
export function createComparator(
  options: CompareOptions,
  strength: Strength = 4,
): (a: ScalarSequence, b: ScalarSequence) => number {
  return (a, b) => compareSequences(a, b, options, strength);
}

export {
  Collator as Collation,
  Collator as CollationBuilder,
  Collator as IncrementalCollator,
};
export default Collator;
