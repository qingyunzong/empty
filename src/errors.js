export const ErrorCode = Object.freeze({
  LEX_ERROR: 'LEX_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
  UNCLOSED_EXPR: 'UNCLOSED_EXPR',
  UNCLOSED_BLOCK: 'UNCLOSED_BLOCK',
  UNEXPECTED_END: 'UNEXPECTED_END',
  UNDEFINED_VARIABLE: 'UNDEFINED_VARIABLE',
  MISSING_FIELD: 'MISSING_FIELD',
  UNKNOWN_FILTER: 'UNKNOWN_FILTER',
  FILTER_TYPE: 'FILTER_TYPE',
  TYPE_ERROR: 'TYPE_ERROR',
  INVALID_PATCH: 'INVALID_PATCH',
});

export class TemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TemplateError';
    this.code = code;
  }
}
