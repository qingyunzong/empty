export class TempRangeError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'TempRangeError';
    this.code = 'TEMP_RANGE';
    this.detail = detail;
  }
}

export class ParseError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ParseError';
    this.code = 'PARSE_ERROR';
    this.detail = detail;
  }
}
