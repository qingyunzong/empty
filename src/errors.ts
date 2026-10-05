export type FsErrorCode =
  | "ENOENT"
  | "ENOTDIR"
  | "EISDIR"
  | "ELOOP"
  | "EMLINK"
  | "ESCAPE"
  | "ESTALE"
  | "EINVAL";

export class FsError extends Error {
  readonly code: FsErrorCode;

  constructor(code: FsErrorCode, message: string) {
    super(message);
    this.name = "FsError";
    this.code = code;
  }
}
