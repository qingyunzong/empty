/** Thrown when a template contains a `$` reference that is malformed,
 *  out of range, or targets a capture group that did not participate. */
export class InvalidCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCaptureError";
  }
}

/** Thrown when the given matches overlap, are unsorted, or out of bounds. */
export class InvalidMatchesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMatchesError";
  }
}

/** Thrown when the expanded output would exceed the configured budget. */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}
