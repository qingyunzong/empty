export type ProjectionErrorCode =
  | "INVALID_PATH"
  | "INVALID_COLUMN"
  | "DUPLICATE_COLUMN"
  | "INVALID_OPTION"
  | "TYPE_MISMATCH"
  | "ROW_LIMIT_EXCEEDED";

export class ProjectionError extends Error {
  readonly code: ProjectionErrorCode;

  constructor(code: ProjectionErrorCode, message: string) {
    super(message);
    this.name = "ProjectionError";
    this.code = code;
  }
}
