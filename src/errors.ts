export type ParseErrorCode =
  | "INVALID_CHAR"
  | "NO_DIGITS"
  | "MISSING_DIGITS_BEFORE_UNIT"
  | "SEGMENT_TOO_LONG"
  | "DUPLICATE_UNIT"
  | "UNIT_ORDER"
  | "MISSING_FRACTION"
  | "FRACTION_TOO_LONG"
  | "UNEXPECTED_TOKEN";

export class ParseError extends Error {
  readonly code: ParseErrorCode;
  readonly offset: number;
  constructor(code: ParseErrorCode, message: string, offset: number) {
    super(message);
    this.name = "ParseError";
    this.code = code;
    this.offset = offset;
  }
}

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
  }
}
