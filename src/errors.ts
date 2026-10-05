export class JsonSyntaxError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} (offset ${offset})`);
    this.name = 'JsonSyntaxError';
    this.offset = offset;
  }
}

export class DuplicateKeyError extends Error {
  readonly pointer: string;
  readonly key: string;
  readonly offset: number;

  constructor(pointer: string, key: string, offset: number) {
    super(
      `Duplicate decoded key ${JSON.stringify(key)} in object at ` +
        `${pointer === '' ? '(root)' : pointer} (offset ${offset})`,
    );
    this.name = 'DuplicateKeyError';
    this.pointer = pointer;
    this.key = key;
    this.offset = offset;
  }
}
