import { Rational, type RationalInput } from "./rational.js";

export interface SizeEntry {
  /** Host-provided media condition; omitted means "matches". */
  media?: string;
  /** Deterministic sizes expression, not raw CSS sizes syntax. */
  expression: string;
}

export type SizeExpressionFailureReason =
  | "empty-expression"
  | "unsupported-function"
  | "unsupported-unit"
  | "unsupported-operator"
  | "unsupported-unary-sign"
  | "invalid-number"
  | "missing-unit"
  | "invalid-function-arguments"
  | "invalid-syntax"
  | "non-positive-result";

export interface SizeExpressionFailure {
  ok: false;
  reason: SizeExpressionFailureReason;
  position: number;
  detail: string;
}

export interface SizeExpressionSuccess {
  ok: true;
  value: Rational;
}

export type SizeExpressionResult =
  | SizeExpressionSuccess
  | SizeExpressionFailure;

export interface SizeEntryIssue {
  index: number;
  entry: SizeEntry;
  reason: SizeExpressionFailureReason | "media-no-match";
  position: number | null;
  detail: string;
}

export interface SlotWidthSelection {
  slotWidth: Rational;
  entryIndex: number | null;
  entry: SizeEntry | null;
  usedViewportFallback: boolean;
  issues: SizeEntryIssue[];
}

export type SizeMediaMatcher = (media: string, entryIndex: number) => boolean;

class ExpressionError extends Error {
  readonly reason: SizeExpressionFailureReason;
  readonly position: number;

  constructor(
    reason: SizeExpressionFailureReason,
    position: number,
    detail: string,
  ) {
    super(detail);
    this.reason = reason;
    this.position = position;
  }
}

function isAsciiWhitespace(character: string): boolean {
  return /[\t\n\f\r ]/.test(character);
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function isAsciiLetter(character: string): boolean {
  return (
    (character >= "a" && character <= "z") ||
    (character >= "A" && character <= "Z")
  );
}

class ExpressionParser {
  private readonly text: string;
  private readonly viewportWidth: Rational;
  private position = 0;

  constructor(text: string, viewportWidth: Rational) {
    this.text = text;
    this.viewportWidth = viewportWidth;
  }

  parse(): Rational {
    this.skipWhitespace();
    if (this.position >= this.text.length) {
      throw new ExpressionError(
        "empty-expression",
        this.position,
        "sizes expression is empty",
      );
    }

    const value = this.parseExpression();
    this.skipWhitespace();
    if (this.position < this.text.length) {
      throw new ExpressionError(
        "invalid-syntax",
        this.position,
        `unexpected character "${this.text[this.position]}"`,
      );
    }
    if (!value.isPositive()) {
      throw new ExpressionError(
        "non-positive-result",
        this.position,
        "sizes expression must produce a positive length",
      );
    }
    return value;
  }

  private skipWhitespace(): void {
    while (
      this.position < this.text.length &&
      isAsciiWhitespace(this.text[this.position])
    ) {
      this.position += 1;
    }
  }

  private parseExpression(): Rational {
    let value = this.parsePrimary();

    while (true) {
      this.skipWhitespace();
      const operator = this.text[this.position];
      if (operator !== "+" && operator !== "-") {
        break;
      }
      const operatorPosition = this.position;
      this.position += 1;
      this.skipWhitespace();
      if (this.position >= this.text.length) {
        throw new ExpressionError(
          "invalid-syntax",
          operatorPosition,
          "missing right operand",
        );
      }
      const right = this.parsePrimary();
      value = operator === "+" ? value.add(right) : value.subtract(right);
    }

    return value;
  }

  private parsePrimary(): Rational {
    this.skipWhitespace();
    if (this.position >= this.text.length) {
      throw new ExpressionError(
        "invalid-syntax",
        this.position,
        "expected a length",
      );
    }

    const character = this.text[this.position];
    if (character === "(") {
      const openPosition = this.position;
      this.position += 1;
      this.skipWhitespace();
      if (this.text[this.position] === ")") {
        throw new ExpressionError(
          "invalid-syntax",
          openPosition,
          "parenthesized expression is empty",
        );
      }
      const value = this.parseExpression();
      this.skipWhitespace();
      if (this.text[this.position] !== ")") {
        throw new ExpressionError(
          "invalid-syntax",
          this.position,
          "missing closing parenthesis",
        );
      }
      this.position += 1;
      return value;
    }

    if (character === "+" || character === "-") {
      throw new ExpressionError(
        "unsupported-unary-sign",
        this.position,
        "unary signs are not supported",
      );
    }

    if (character === "*" || character === "/") {
      throw new ExpressionError(
        "unsupported-operator",
        this.position,
        "multiplication and division are not supported",
      );
    }

    if (isDigit(character)) {
      return this.parseLength();
    }

    if (isAsciiLetter(character)) {
      return this.parseFunction();
    }

    throw new ExpressionError(
      "invalid-syntax",
      this.position,
      `unexpected character "${character}"`,
    );
  }

  private parseLength(): Rational {
    const numberStart = this.position;
    while (
      this.position < this.text.length &&
      isDigit(this.text[this.position])
    ) {
      this.position += 1;
    }
    if (this.text[this.position] === ".") {
      const dotPosition = this.position;
      this.position += 1;
      if (
        this.position >= this.text.length ||
        !isDigit(this.text[this.position])
      ) {
        throw new ExpressionError(
          "invalid-number",
          dotPosition,
          "decimal point must have digits on both sides",
        );
      }
      while (
        this.position < this.text.length &&
        isDigit(this.text[this.position])
      ) {
        this.position += 1;
      }
    }
    const numberText = this.text.slice(numberStart, this.position);
    const number = Rational.fromUnsignedDecimal(numberText);
    if (number === null) {
      throw new ExpressionError(
        "invalid-number",
        numberStart,
        `invalid decimal number: ${numberText}`,
      );
    }

    const unitStart = this.position;
    while (
      this.position < this.text.length &&
      isAsciiLetter(this.text[this.position])
    ) {
      this.position += 1;
    }
    const unit = this.text.slice(unitStart, this.position).toLowerCase();
    if (unit === "") {
      throw new ExpressionError(
        "missing-unit",
        unitStart,
        "length must have a px or vw unit",
      );
    }
    if (unit === "px") {
      return number;
    }
    if (unit === "vw") {
      return number.multiply(this.viewportWidth).divide(100);
    }
    throw new ExpressionError(
      "unsupported-unit",
      unitStart,
      `unsupported length unit: ${unit}`,
    );
  }

  private parseFunction(): Rational {
    const nameStart = this.position;
    while (
      this.position < this.text.length &&
      isAsciiLetter(this.text[this.position])
    ) {
      this.position += 1;
    }
    const name = this.text.slice(nameStart, this.position).toLowerCase();
    if (name !== "min" && name !== "max") {
      throw new ExpressionError(
        "unsupported-function",
        nameStart,
        `unsupported function: ${name}`,
      );
    }
    if (this.text[this.position] !== "(") {
      throw new ExpressionError(
        "invalid-syntax",
        this.position,
        `function ${name} must be followed by "("`,
      );
    }
    const openPosition = this.position;
    this.position += 1;

    const argumentsList: Rational[] = [];
    this.skipWhitespace();
    if (this.text[this.position] === ")") {
      throw new ExpressionError(
        "invalid-function-arguments",
        openPosition,
        `${name} requires at least two arguments`,
      );
    }

    while (true) {
      argumentsList.push(this.parseExpression());
      this.skipWhitespace();
      const separator = this.text[this.position];
      if (separator === ",") {
        this.position += 1;
        this.skipWhitespace();
        if (this.text[this.position] === ")") {
          throw new ExpressionError(
            "invalid-function-arguments",
            this.position,
            "trailing comma in function arguments",
          );
        }
        continue;
      }
      if (separator === ")") {
        this.position += 1;
        break;
      }
      throw new ExpressionError(
        "invalid-function-arguments",
        this.position,
        `expected "," or ")" in ${name} arguments`,
      );
    }

    if (argumentsList.length < 2) {
      throw new ExpressionError(
        "invalid-function-arguments",
        openPosition,
        `${name} requires at least two arguments`,
      );
    }

    let result = argumentsList[0];
    for (let index = 1; index < argumentsList.length; index += 1) {
      const candidate = argumentsList[index];
      const comparison = candidate.compare(result);
      if (
        (name === "min" && comparison < 0) ||
        (name === "max" && comparison > 0)
      ) {
        result = candidate;
      }
    }
    return result;
  }
}

/**
 * Evaluates the deterministic sizes expression grammar. Literal lengths may be
 * zero; intermediate subtraction may be negative; the final result must be
 * strictly positive.
 */
export function evaluateSizeExpression(
  expression: string,
  viewportWidth: RationalInput,
): SizeExpressionResult {
  const width = Rational.from(viewportWidth);
  if (!width.isPositive()) {
    throw new TypeError("viewportWidth must be positive");
  }
  try {
    const value = new ExpressionParser(expression, width).parse();
    return { ok: true, value };
  } catch (error) {
    if (error instanceof ExpressionError) {
      return {
        ok: false,
        reason: error.reason,
        position: error.position,
        detail: error.message,
      };
    }
    throw error;
  }
}

/**
 * Picks the first sizes entry whose media matches and whose expression yields
 * a positive length. If none does, the viewport width is the slot width.
 */
export function selectSlotWidth(
  entries: readonly SizeEntry[],
  viewportWidth: RationalInput,
  mediaMatches: SizeMediaMatcher,
): SlotWidthSelection {
  const width = Rational.from(viewportWidth);
  if (!width.isPositive()) {
    throw new TypeError("viewportWidth must be positive");
  }

  const issues: SizeEntryIssue[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const mediaMatched =
      entry.media === undefined || entry.media.trim() === ""
        ? true
        : mediaMatches(entry.media, index);
    if (!mediaMatched) {
      issues.push({
        index,
        entry,
        reason: "media-no-match",
        position: null,
        detail: `media condition did not match: ${entry.media ?? ""}`,
      });
      continue;
    }

    const evaluated = evaluateSizeExpression(entry.expression, width);
    if (!evaluated.ok) {
      issues.push({
        index,
        entry,
        reason: evaluated.reason,
        position: evaluated.position,
        detail: evaluated.detail,
      });
      continue;
    }
    if (!evaluated.value.isPositive()) {
      issues.push({
        index,
        entry,
        reason: "non-positive-result",
        position: null,
        detail: "sizes expression must produce a positive length",
      });
      continue;
    }

    return {
      slotWidth: evaluated.value,
      entryIndex: index,
      entry,
      usedViewportFallback: false,
      issues,
    };
  }

  return {
    slotWidth: width,
    entryIndex: null,
    entry: null,
    usedViewportFallback: true,
    issues,
  };
}
