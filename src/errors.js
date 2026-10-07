export class RouteError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'RouteError';
    this.code = code;
  }
}
