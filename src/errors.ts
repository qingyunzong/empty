export class LineageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnknownTableError extends LineageError {
  constructor(public readonly table: string) {
    super(`unknown table: ${table}`);
  }
}

export class UnknownColumnError extends LineageError {
  constructor(public readonly column: string) {
    super(`unknown column: ${column}`);
  }
}

export class AmbiguousColumnError extends LineageError {
  constructor(
    public readonly column: string,
    public readonly candidates: readonly string[],
  ) {
    super(`ambiguous column: ${column} (candidates: ${candidates.join(", ")})`);
  }
}
