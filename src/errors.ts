/** Error thrown for lexical / grammatical problems. */
export class ParseError extends Error {
  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
  ) {
    super(`${message} at ${start}..${end}`);
    this.name = "ParseError";
  }
}

/** Error thrown while evaluating a well-formed expression. */
export class CalcError extends Error {
  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
  ) {
    super(`${message} at ${start}..${end}`);
    this.name = "CalcError";
  }
}

export interface SideInfo {
  readonly start: number;
  readonly end: number;
  /** Canonical unit string of that side, e.g. "kg*m*s^-2". */
  readonly unit: string;
}

/**
 * Dimension mismatch on '+'/'-'. Carries the source range of the whole
 * subexpression plus the range and canonical unit of each side. A zero
 * value does NOT exempt an operand from this check.
 */
export class UnitError extends CalcError {
  readonly left: SideInfo;
  readonly right: SideInfo;

  constructor(
    op: "+" | "-",
    left: SideInfo,
    right: SideInfo,
    start: number,
    end: number,
  ) {
    super(
      `dimension mismatch for '${op}': ` +
        `left is '${left.unit}' (${left.start}..${left.end}), ` +
        `right is '${right.unit}' (${right.start}..${right.end})`,
      start,
      end,
    );
    this.name = "UnitError";
    this.left = left;
    this.right = right;
  }
}
