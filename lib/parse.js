export class DataError extends Error {
  constructor(line, message) {
    super(message);
    this.name = "DataError";
    this.line = line;
  }
}

const TYPES = new Set(["auth", "capture", "void"]);

// Parse and validate one JSONL event line. Throws DataError (carrying the
// 1-based line number) on any malformed input; callers map this to exit 2.
export function parseLine(line, lineNo) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    throw new DataError(lineNo, "invalid JSON");
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new DataError(lineNo, "event must be a JSON object");
  }
  const { type, id, mch, amt, ts } = obj;
  if (typeof type !== "string" || !TYPES.has(type)) {
    throw new DataError(lineNo, `unknown event type: ${String(type)}`);
  }
  if (typeof id !== "string" || id.length === 0) {
    throw new DataError(lineNo, "id must be a non-empty string");
  }
  if (typeof mch !== "string" || mch.length === 0) {
    throw new DataError(lineNo, "mch must be a non-empty string");
  }
  if (typeof ts !== "number" || !Number.isFinite(ts)) {
    throw new DataError(lineNo, "ts must be a finite number");
  }
  if (type === "auth" || type === "capture") {
    if (typeof amt !== "number" || !Number.isInteger(amt)) {
      throw new DataError(lineNo, "amt must be an integer number of cents");
    }
    if (amt < 0) {
      throw new DataError(lineNo, "amt must not be negative");
    }
  }
  return { type, id, mch, amt: type === "void" ? undefined : amt, ts };
}
