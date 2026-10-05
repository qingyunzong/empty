export type ParseErrorCode = "eof" | "overflow";

/** schema 定义本身非法（含定义图循环）。 */
export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

/** 数据解析失败。at 为失败实际发生处的偏移。 */
export class ParseError extends Error {
  readonly code: ParseErrorCode;
  readonly at: number;
  constructor(code: ParseErrorCode, at: number, message: string) {
    super(message);
    this.name = "ParseError";
    this.code = code;
    this.at = at;
  }
}
