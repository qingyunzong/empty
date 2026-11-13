export const CURSOR_VERSION = 1;

export interface CursorPayload {
  v: number;
  key: string;
  gen: number;
}

export class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

export function encodeCursor(key: string, gen: number): string {
  const payload: CursorPayload = { v: CURSOR_VERSION, key, gen };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('cursor is not valid base64url JSON');
  }
  const payload = parsed as Partial<CursorPayload> | null;
  if (
    payload === null ||
    typeof payload !== 'object' ||
    payload.v !== CURSOR_VERSION ||
    typeof payload.key !== 'string' ||
    typeof payload.gen !== 'number' ||
    !Number.isInteger(payload.gen)
  ) {
    throw new InvalidCursorError('cursor payload is malformed');
  }
  return payload as CursorPayload;
}

export function compareCursors(a: string, b: string): number {
  const keyA = decodeCursor(a).key;
  const keyB = decodeCursor(b).key;
  if (keyA < keyB) return -1;
  if (keyA > keyB) return 1;
  return 0;
}
