export class EdifactParseError extends Error {
  readonly code: string;
  readonly byteOffset: number | undefined;

  constructor(message: string, code = "syntax", byteOffset?: number) {
    super(message);
    this.name = "EdifactParseError";
    this.code = code;
    this.byteOffset = byteOffset;
  }
}

export class EdifactEncodeError extends Error {
  readonly code: string;

  constructor(message: string, code = "encode") {
    super(message);
    this.name = "EdifactEncodeError";
    this.code = code;
  }
}
