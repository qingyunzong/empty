export class CancelError extends Error {
  constructor(message = "task cancelled") {
    super(message);
    this.name = "CancelError";
  }
}

export class TimeoutError extends Error {
  constructor(message = "operation timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

export class DeadlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeadlockError";
  }
}

export class ReplayMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayMismatchError";
  }
}
