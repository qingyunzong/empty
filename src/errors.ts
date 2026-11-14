import type { AliasCycle, SourceRange } from "./types.ts";

export type YamlGraphErrorCode =
  | "SYNTAX_ERROR"
  | "DUPLICATE_KEY"
  | "UNKNOWN_ANCHOR"
  | "ALIAS_CYCLE"
  | "ALIAS_BUDGET"
  | "ALIAS_COUNT"
  | "ALIAS_DEPTH"
  | "MAX_NODES"
  | "MAX_DEPTH"
  | "MERGE_TYPE"
  | "MERGE_CYCLE"
  | "MERGE_DEPTH";

export interface YamlGraphErrorDetails {
  path?: string;
  range?: SourceRange;
  anchor?: string;
  cycle?: AliasCycle;
  limit?: number;
  actual?: number;
  key?: string;
  firstRange?: SourceRange;
  [key: string]: unknown;
}

export class YamlGraphError extends Error {
  readonly code: YamlGraphErrorCode;
  readonly path?: string;
  readonly range?: SourceRange;
  readonly details: YamlGraphErrorDetails;

  constructor(
    code: YamlGraphErrorCode,
    message: string,
    details: YamlGraphErrorDetails = {},
  ) {
    super(message);
    this.name = "YamlGraphError";
    this.code = code;
    this.path = details.path;
    this.range = details.range;
    this.details = details;
  }
}

export class YamlSyntaxError extends YamlGraphError {
  constructor(message: string, details: YamlGraphErrorDetails = {}) {
    super("SYNTAX_ERROR", message, details);
    this.name = "YamlSyntaxError";
  }
}

export function formatErrorLocation(range?: SourceRange): string {
  if (!range) return "";
  return ` at line ${range.start.line}, column ${range.start.column}`;
}
