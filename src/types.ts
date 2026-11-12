export type IntegerInput = bigint | number | string;

export type CounterStyle = "decimal" | "lower-alpha";

export type ContentPhase = "before" | "after";

export type ContentTokenKind = "literal" | "counter" | "counters";

export interface LiteralToken {
  kind: "literal";
  value: string;
}

export interface CounterToken {
  kind: "counter";
  name: string;
  style: CounterStyle;
}

export interface CountersToken {
  kind: "counters";
  name: string;
  separator: string;
  style: CounterStyle;
}

export type ContentToken = LiteralToken | CounterToken | CountersToken;

export interface CounterAssignment {
  name: string;
  value: IntegerInput;
}

export interface CounterReset {
  name: string;
  value?: IntegerInput;
}

export interface StyleInstructions {
  reset?: readonly (string | CounterReset)[];
  set?: readonly CounterAssignment[];
  increment?: readonly CounterAssignment[];
}

export interface ParsedNode {
  id: string;
  before?: readonly ContentToken[];
  after?: readonly ContentToken[];
  instructions?: StyleInstructions;
  children?: readonly ParsedNode[];
  skipSubtree?: boolean;
  suppressText?: boolean;
}

export interface InitialCounterDeclaration {
  name: string;
  value: IntegerInput;
}

export type InitialCounters =
  | Readonly<Record<string, IntegerInput>>
  | readonly InitialCounterDeclaration[];

export interface ExtractionInput {
  roots: readonly ParsedNode[];
  initialCounters: InitialCounters;
  outputByteBudget?: IntegerInput;
}

export interface CounterRead {
  name: string;
  createdBy: string;
  value: string;
}

export interface ExtractionSegment {
  nodeId: string;
  position: ContentPhase;
  tokenIndex: number;
  kind: ContentTokenKind;
  text: string;
  reads: readonly CounterRead[];
}

export interface ExtractionResult {
  text: string;
  segments: readonly ExtractionSegment[];
}

export type ExtractionErrorCode =
  | "INVALID_INPUT"
  | "INVALID_TREE"
  | "DUPLICATE_ID"
  | "MULTIPLE_PARENTS"
  | "CYCLE"
  | "INVALID_NUMBER"
  | "UNKNOWN_COUNTER"
  | "DUPLICATE_INSTRUCTION"
  | "INVALID_TOKEN"
  | "OUTPUT_BUDGET_EXCEEDED";

export class ExtractionError extends Error {
  readonly code: ExtractionErrorCode;
  readonly path?: string;

  constructor(code: ExtractionErrorCode, message: string, path?: string) {
    super(path === undefined ? message : `${path}: ${message}`);
    this.name = "ExtractionError";
    this.code = code;
    this.path = path;
  }
}
