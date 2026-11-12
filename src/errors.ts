export type JoinErrorCode =
  | 'EMPTY_INPUT'
  | 'INVALID_RELATION_NAME'
  | 'DUPLICATE_RELATION_NAME'
  | 'UNKNOWN_EDGE_ENDPOINT'
  | 'SELF_LOOP_EDGE'
  | 'DUPLICATE_EDGE'
  | 'NOT_CONNECTED'
  | 'CYCLE_DETECTED'
  | 'INVALID_ATTRIBUTE'
  | 'TYPE_MISMATCH'
  | 'INVALID_ROW_SHAPE'
  | 'INVALID_INTEGER'
  | 'RUNNING_INTERSECTION_VIOLATION'
  | 'TOKEN_CORRUPT'
  | 'TOKEN_INPUT_MISMATCH'
  | 'INVALID_LIMIT';

export class JoinEngineError extends Error {
  readonly code: JoinErrorCode;

  constructor(code: JoinErrorCode, message: string) {
    super(message);
    this.name = 'JoinEngineError';
    this.code = code;
    Object.setPrototypeOf(this, JoinEngineError.prototype);
  }
}
