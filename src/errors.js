export class ApiError extends Error {
  constructor(code, extra) {
    super(code);
    this.name = 'ApiError';
    this.code = code;
    this.extra = extra;
  }
}
