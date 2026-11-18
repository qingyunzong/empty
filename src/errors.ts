/**
 * Error raised for invalid conversion tables, resources, or retention data.
 *
 * `code` is stable and intended for callers that need to branch on the
 * failure kind without parsing the message.
 */
export class ConversionError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ConversionError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
