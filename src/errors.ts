export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

export class FieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldError";
  }
}
