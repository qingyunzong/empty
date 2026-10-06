export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

export class ReservationExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReservationExceededError";
  }
}

export class TerminalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalStateError";
  }
}

export class StaleGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleGenerationError";
  }
}
